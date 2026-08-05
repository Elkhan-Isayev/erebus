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

/** Non-live scans give up when the cluster goes quiet for this long. */
const IDLE_TIMEOUT_MS = 8_000;
const FLUSH_INTERVAL_MS = 120;
const FLUSH_SIZE = 40;

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
    const headers = Object.fromEntries(message.headers.map((h) => [h.key, h.value]));
    const parse = (text: string | null) => {
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    try {
      return Boolean(fn(parse(message.key.text), parse(message.value.text), headers, message));
    } catch {
      return false;
    }
  };
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
  const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
  const allPartitions = metadata.topics[0]?.partitions.map((p) => p.partitionId).sort((a, b) => a - b) ?? [];
  const partitions = query.partitions?.length ? allPartitions.filter((p) => query.partitions!.includes(p)) : allPartitions;
  if (partitions.length === 0) throw new Error(`Topic ${topic} has no matching partitions`);

  const watermarks = await admin.fetchTopicOffsets(topic);
  const wmByPartition = new Map(watermarks.map((w) => [w.partition, w]));

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

  const predicate = buildPredicate(query.filterExpression);
  const needle = query.search?.trim().toLowerCase() ?? '';
  const startedAt = Date.now();
  const groupId = `erebus-viewer-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const consumer = scratchConsumer(clusterId, groupId);

  let scanned = 0;
  let matched = 0;
  let finished = false;
  let buffer: KafkaMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.length > 0) {
      emit('consume:messages', { sessionId, messages: buffer });
      buffer = [];
    }
  };

  const progress = (done: boolean, error?: string): ConsumeProgress => ({
    sessionId,
    scanned,
    matched,
    done,
    error,
    elapsedMs: Date.now() - startedAt,
  });

  const scheduleFlush = () => {
    if (buffer.length >= FLUSH_SIZE) return flush();
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
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
    try {
      await admin.deleteGroups([groupId]);
    } catch {
      /* transient group cleanup is best-effort */
    }
  };

  function finish(error?: string) {
    if (finished) return;
    finished = true;
    flush();
    emit('consume:progress', progress(true, error));
    void cleanup();
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
        pause();
        return;
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
          pause();
          break;
        }
        scanned++;

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
          headers: Object.entries(message.headers ?? {}).map(([k, v]) => ({
            key: k,
            value: v === null || v === undefined ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v),
          })),
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
      if (progress.error) reject(new Error(progress.error));
      else resolve({ messages: collected, scanned: progress.scanned, elapsedMs: progress.elapsedMs });
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
