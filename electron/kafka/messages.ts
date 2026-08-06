import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import type { CompressionTypes } from 'kafkajs';
import { CompressionTypes as Compression } from 'kafkajs';
import type { ConsumeProgress, ConsumeQuery, KafkaMessage, ProduceInput } from '../../shared/types';
import { adminFor, assertWritable, producerFor, scratchConsumer } from './pool';
import { decode, encode } from './serde';

type Emit = (channel: string, payload: unknown) => void;

interface Session {
  stop: () => void;
  stopped: boolean;
}

const sessions = new Map<string, Session>();
/** Cleanup runs after a session ends; one-shot callers wait for it so no group is left behind. */
const cleanups = new Map<string, Promise<void>>();

const awaitCleanup = (sessionId: string): Promise<void> => cleanups.get(sessionId) ?? Promise.resolve();

/** Non-live scans give up when the cluster goes quiet for this long. */
const IDLE_TIMEOUT_MS = 8_000;
const FLUSH_INTERVAL_MS = 120;
const FLUSH_SIZE = 40;

/**
 * A live tail can outrun any table. The UI only keeps `liveTailBuffer` rows, so pushing
 * every message across the IPC boundary just to have it discarded starves the renderer
 * and, with it, the consumer. Live sessions therefore emit on a fixed cadence and only
 * send the newest slice; `scanned` still reports the real volume.
 */
const LIVE_FLUSH_INTERVAL_MS = 250;
const LIVE_MAX_PER_FLUSH = 200;

function buildPredicate(expression?: string) {
  if (!expression?.trim()) return null;
  const script = new vm.Script(`(function(key, value, headers, message){ return (${expression}); })`);
  const context = vm.createContext(Object.create(null));
  const fn = script.runInContext(context, { timeout: 500 }) as (
    key: unknown,
    value: unknown,
    headers: Record<string, string>,
    message: KafkaMessage,
  ) => unknown;
  return (message: KafkaMessage): boolean => {
    const parse = (text: string | null) => {
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    // Header values are often JSON documents; hand them over parsed.
    const headers = Object.fromEntries(message.headers.map((h) => [h.key, parse(h.value)]));
    try {
      return Boolean(fn(parse(message.key.text), parse(message.value.text), headers, message));
    } catch {
      return false;
    }
  };
}

/** Kafka headers are bytes and may repeat; binary ones fall back to base64. */
function decodeHeaders(raw: unknown): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    for (const single of Array.isArray(value) ? value : [value]) {
      if (single === null || single === undefined) {
        out.push({ key, value: '' });
        continue;
      }
      if (!Buffer.isBuffer(single)) {
        out.push({ key, value: String(single) });
        continue;
      }
      const text = single.toString('utf8');
      // eslint-disable-next-line no-control-regex
      const binary = /[\u0000-\u0008\u000e-\u001f]/.test(text);
      out.push({ key, value: binary ? single.toString('base64') : text });
    }
  }
  return out;
}

function matchesSearch(message: KafkaMessage, needle: string): boolean {
  const hay = `${message.key.text ?? ''}\n${message.value.text ?? ''}\n${message.headers
    .map((h) => `${h.key}=${h.value}`)
    .join('\n')}`;
  return hay.toLowerCase().includes(needle);
}

export async function stopConsume(sessionId: string): Promise<void> {
  sessions.get(sessionId)?.stop();
}

export function stopAllConsumers(): void {
  for (const session of sessions.values()) session.stop();
}

export async function startConsume(query: ConsumeQuery, emit: Emit): Promise<void> {
  const { sessionId, clusterId, topic, limit, live } = query;
  if (sessions.has(sessionId)) throw new Error(`Session ${sessionId} is already running`);

  const admin = await adminFor(clusterId);
  // fetchTopicOffsets answers from the brokers themselves; cached metadata can still be
  // showing a topic as it looked seconds ago, which used to hide whole partitions.
  const [watermarks, metadata] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchTopicMetadata({ topics: [topic] }).catch(() => ({ topics: [] as { partitions: { partitionId: number }[] }[] })),
  ]);
  const wmByPartition = new Map(watermarks.map((w) => [w.partition, w]));

  const allPartitions = [
    ...new Set([
      ...watermarks.map((w) => w.partition),
      ...(metadata.topics[0]?.partitions.map((p) => p.partitionId) ?? []),
    ]),
  ].sort((a, b) => a - b);

  const requested = query.partitions?.length ? new Set(query.partitions) : null;
  const excluded = (partition: number) => requested !== null && !requested.has(partition);
  const partitions = requested ? allPartitions.filter((p) => requested.has(p)) : allPartitions;
  if (partitions.length === 0) throw new Error(`Topic ${topic} has no matching partitions`);

  let timestampOffsets: Map<number, string> | null = null;
  if (query.seek === 'timestamp') {
    const ts = Number(query.seekTo ?? Date.now());
    const byTs = await admin.fetchTopicOffsetsByTimestamp(topic, ts);
    timestampOffsets = new Map(byTs.map((o) => [o.partition, o.offset]));
  }

  const perPartition = BigInt(Math.max(1, Math.ceil(limit / partitions.length)));
  const startOffsets = new Map<number, bigint>();
  const endOffsets = new Map<number, bigint>();

  for (const partition of partitions) {
    const wm = wmByPartition.get(partition);
    const low = BigInt(wm?.low ?? '0');
    const high = BigInt(wm?.high ?? '0');
    endOffsets.set(partition, high);
    let start: bigint;
    switch (query.seek) {
      case 'earliest':
        start = low;
        break;
      case 'offset':
        start = BigInt(query.seekTo ?? low.toString());
        break;
      case 'timestamp': {
        const raw = timestampOffsets?.get(partition);
        start = raw && BigInt(raw) >= 0n ? BigInt(raw) : high;
        break;
      }
      case 'latest':
      default:
        start = live ? high : high - perPartition;
        break;
    }
    if (start < low) start = low;
    if (start > high) start = high;
    startOffsets.set(partition, start);
  }

  const active = new Set(
    partitions.filter((p) => live || (startOffsets.get(p) ?? 0n) < (endOffsets.get(p) ?? 0n)),
  );
  /** Where each partition should resume — advanced as messages arrive so a rebalance re-seeks correctly. */
  const nextOffsets = new Map(startOffsets);
  /** Partitions that already reached their end offset in a bounded scan. */
  const completed = new Set<number>();

  const predicate = buildPredicate(query.filterExpression);
  const needle = query.search?.trim().toLowerCase() ?? '';
  const startedAt = Date.now();
  const groupId = `erebus-viewer-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const consumer = scratchConsumer(clusterId, groupId);

  let scanned = 0;
  let matched = 0;
  let dropped = 0;
  let finished = false;
  let buffer: KafkaMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let rateWindowStart = Date.now();
  let rateWindowScanned = 0;
  let rate = 0;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.length === 0) return;
    const payload = live && buffer.length > LIVE_MAX_PER_FLUSH ? buffer.slice(-LIVE_MAX_PER_FLUSH) : buffer;
    dropped += buffer.length - payload.length;
    buffer = [];
    emit('consume:messages', { sessionId, messages: payload });
  };

  const progress = (done: boolean, error?: string): ConsumeProgress => ({
    sessionId,
    scanned,
    matched,
    done,
    error,
    elapsedMs: Date.now() - startedAt,
    rate,
    dropped,
  });

  const scheduleFlush = () => {
    if (live) {
      if (!flushTimer) flushTimer = setTimeout(flush, LIVE_FLUSH_INTERVAL_MS);
      return;
    }
    if (buffer.length >= FLUSH_SIZE) return flush();
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  };

  const tickRate = () => {
    const now = Date.now();
    const windowMs = now - rateWindowStart;
    if (windowMs < 1000) return;
    rate = Math.round((rateWindowScanned / windowMs) * 1000);
    rateWindowStart = now;
    rateWindowScanned = 0;
  };

  const armIdle = () => {
    if (live) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(), IDLE_TIMEOUT_MS);
  };

  const cleanup = async () => {
    if (flushTimer) clearTimeout(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    sessions.delete(sessionId);
    try {
      await consumer.disconnect();
    } catch {
      /* ignore */
    }
    // The coordinator can still consider the group non-empty for a moment after the
    // consumer disconnects, and deleting it then fails — leaving our scratch group behind
    // in everyone's consumer list. A couple of retries clears that up.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await admin.deleteGroups([groupId]);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  };

  function finish(error?: string) {
    if (finished) return;
    finished = true;
    flush();
    // Register the cleanup before announcing completion: `emit` calls listeners
    // synchronously, and a one-shot caller looks the promise up the moment it hears "done".
    cleanups.set(
      sessionId,
      cleanup().finally(() => cleanups.delete(sessionId)),
    );
    emit('consume:progress', progress(true, error));
  }

  sessions.set(sessionId, {
    stopped: false,
    stop: () => finish(),
  });

  if (active.size === 0) {
    finish();
    return;
  }

  const seekActivePartitions = () => {
    for (const partition of partitions) {
      if (!active.has(partition)) continue;
      try {
        consumer.seek({ topic, partition, offset: (nextOffsets.get(partition) ?? 0n).toString() });
      } catch {
        // The group is not joined yet — the GROUP_JOIN handler will seek again.
      }
    }
  };

  // seek() only works once the group is joined, and a rebalance resets positions — so re-seek on every join.
  let joined = false;
  let resolveJoin: (() => void) | null = null;
  const joinedOnce = new Promise<void>((resolve) => {
    resolveJoin = resolve;
  });
  consumer.on(consumer.events.GROUP_JOIN, () => {
    joined = true;
    seekActivePartitions();
    armIdle();
    resolveJoin?.();
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) finish(payload.error?.message ?? 'Consumer crashed');
  });

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: query.seek === 'earliest' });

  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: Math.min(4, partitions.length),
    eachBatch: async ({ batch, heartbeat, isRunning, isStale, pause, resolveOffset }) => {
      if (finished || !isRunning() || isStale()) return;
      const partition = batch.partition;
      if (!active.has(partition)) {
        // The user asked for a subset, or this partition already reached its end offset.
        if (excluded(partition) || completed.has(partition)) {
          pause();
          return;
        }
        // Otherwise the broker knows a partition our metadata did not: a topic created
        // moments ago, or partitions added while we tail. Adopt it rather than drop its
        // stream on the floor.
        active.add(partition);
        if (!endOffsets.has(partition)) endOffsets.set(partition, BigInt(batch.highWatermark ?? '0'));
        if (!nextOffsets.has(partition)) nextOffsets.set(partition, BigInt(batch.messages[0]?.offset ?? '0'));
      }
      armIdle();
      const end = endOffsets.get(partition) ?? 0n;

      for (const message of batch.messages) {
        if (finished) return;
        const offset = BigInt(message.offset);
        resolveOffset(message.offset);
        // A seek only takes effect on the next fetch, so an in-flight batch can start before it.
        if (offset < (nextOffsets.get(partition) ?? 0n)) continue;
        nextOffsets.set(partition, offset + 1n);
        if (!live && offset >= end) {
          active.delete(partition);
          completed.add(partition);
          pause();
          break;
        }
        scanned++;
        rateWindowScanned++;

        const [key, value] = await Promise.all([
          decode(clusterId, message.key as Buffer | null, query.keySerde),
          decode(clusterId, message.value as Buffer | null, query.valueSerde),
        ]);

        const decoded: KafkaMessage = {
          id: `${partition}-${message.offset}`,
          topic: batch.topic,
          partition,
          offset: message.offset,
          timestamp: message.timestamp,
          key,
          value,
          headers: decodeHeaders(message.headers),
        };

        if (needle && !matchesSearch(decoded, needle)) continue;
        if (predicate && !predicate(decoded)) continue;

        matched++;
        buffer.push(decoded);
        scheduleFlush();

        if (matched >= limit && !live) {
          emit('consume:progress', progress(false));
          finish();
          return;
        }
      }

      tickRate();
      emit('consume:progress', progress(false));
      await heartbeat();

      if (!live && active.size === 0) finish();
    },
  });

  // Wait for the first join so the initial seek lands; a slow coordinator must not lose it.
  await Promise.race([joinedOnce, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  if (!joined && !finished) {
    seekActivePartitions();
    armIdle();
  }
  emit('consume:progress', progress(false));
}

/** One-shot scan used by the MCP server and any caller that just wants the rows. */
export async function consumeBatch(
  query: ConsumeQuery,
): Promise<{ messages: KafkaMessage[]; scanned: number; elapsedMs: number }> {
  const collected: KafkaMessage[] = [];
  const sessionId = query.sessionId || randomUUID();

  return new Promise((resolve, reject) => {
    const emit: Emit = (channel, payload) => {
      if (channel === 'consume:messages') {
        collected.push(...(payload as { messages: KafkaMessage[] }).messages);
        return;
      }
      const progress = payload as ConsumeProgress;
      if (!progress.done) return;
      if (progress.error) {
        reject(new Error(progress.error));
        return;
      }
      // Wait for the scratch consumer group to be gone before handing the rows back:
      // a caller that exits immediately would otherwise leave it on the cluster.
      void awaitCleanup(sessionId).then(() =>
        resolve({ messages: collected, scanned: progress.scanned, elapsedMs: progress.elapsedMs }),
      );
    };
    startConsume({ ...query, sessionId, live: false }, emit).catch(reject);
  });
}

/* ----------------------------------------------------------------- produce */

const COMPRESSION: Record<string, CompressionTypes> = {
  none: Compression.None,
  gzip: Compression.GZIP,
  snappy: Compression.Snappy,
  lz4: Compression.LZ4,
  zstd: Compression.ZSTD,
};

export async function produce(input: ProduceInput): Promise<{ partition: number; offset: string }[]> {
  assertWritable(input.clusterId);
  const producer = await producerFor(input.clusterId);
  const [key, value] = await Promise.all([
    encode(input.clusterId, input.key ?? null, input.keySerde, input.keySubject),
    encode(input.clusterId, input.value ?? null, input.valueSerde, input.valueSubject),
  ]);

  const headers: Record<string, string> = {};
  for (const h of input.headers ?? []) if (h.key) headers[h.key] = h.value;

  const result = await producer.send({
    topic: input.topic,
    acks: -1,
    compression: COMPRESSION[input.compression ?? 'none'] ?? Compression.None,
    messages: [
      {
        key,
        value,
        headers,
        partition: input.partition === null || input.partition === undefined ? undefined : input.partition,
      },
    ],
  });

  return result.map((r) => ({ partition: r.partition, offset: r.baseOffset ?? r.offset ?? '-1' }));
}
