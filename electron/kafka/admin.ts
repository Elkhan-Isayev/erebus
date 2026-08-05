import {
  AclOperationTypes,
  AclPermissionTypes,
  AclResourceTypes,
  AssignerProtocol,
  ConfigResourceTypes,
  ResourcePatternTypes,
  type Admin,
  type DescribeConfigResponse,
  type ITopicConfig,
} from 'kafkajs';
import type {
  AclEntry,
  BrokerInfo,
  ClusterOverview,
  ConfigEntry,
  ConsumerGroupDetail,
  ConsumerGroupOffset,
  ConsumerGroupSummary,
  CreateTopicInput,
  PartitionInfo,
  ResetOffsetInput,
  TopicDetail,
  TopicSummary,
} from '../../shared/types';
import { adminFor, assertWritable, clusterFor } from './pool';

const INTERNAL_PREFIXES = ['__', '_confluent', '_schemas'];

export const isInternalTopic = (name: string) => INTERNAL_PREFIXES.some((p) => name.startsWith(p));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const big = (v: string | number | bigint) => BigInt(v ?? 0);

/* ----------------------------------------------------------------- offsets */

interface TopicOffsets {
  partition: number;
  low: string;
  high: string;
}

const RETRIABLE = ['NOT_LEADER_FOR_PARTITION', 'LEADER_NOT_AVAILABLE', 'UNKNOWN_TOPIC_OR_PARTITION', 'REBALANCE_IN_PROGRESS'];

/** Metadata lags right after a partition or topic change; those errors clear on their own. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const type = (err as { type?: string }).type ?? '';
      if (!RETRIABLE.includes(type)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function topicOffsets(admin: Admin, topic: string): Promise<TopicOffsets[]> {
  const raw = await withRetry(() => admin.fetchTopicOffsets(topic));
  return raw.map((p) => ({ partition: p.partition, low: p.low, high: p.high }));
}

const countMessages = (offsets: TopicOffsets[]) =>
  offsets.reduce((sum, p) => sum + (big(p.high) - big(p.low)), 0n).toString();

/* ------------------------------------------------------------------ configs */

function toConfigEntries(res: DescribeConfigResponse['resources'][number]): ConfigEntry[] {
  return res.configEntries
    .map((e) => ({
      name: e.configName,
      value: e.configValue ?? null,
      isDefault: Boolean(e.isDefault),
      isSensitive: Boolean(e.isSensitive),
      isReadOnly: Boolean(e.readOnly),
      source: (e as { configSource?: string | number }).configSource?.toString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function describeTopicConfigs(admin: Admin, topics: string[]): Promise<Map<string, ConfigEntry[]>> {
  const out = new Map<string, ConfigEntry[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < topics.length; i += 40) chunks.push(topics.slice(i, i + 40));
  await mapLimit(chunks, 4, async (chunk) => {
    const res = await admin.describeConfigs({
      includeSynonyms: false,
      resources: chunk.map((name) => ({ type: ConfigResourceTypes.TOPIC, name })),
    });
    for (const resource of res.resources) out.set(resource.resourceName, toConfigEntries(resource));
  });
  return out;
}

const configValue = (entries: ConfigEntry[] | undefined, name: string, fallback = '') =>
  entries?.find((e) => e.name === name)?.value ?? fallback;

/* ----------------------------------------------------------------- cluster */

export async function getBrokers(clusterId: string): Promise<BrokerInfo[]> {
  const admin = await adminFor(clusterId);
  const cluster = await admin.describeCluster();
  return cluster.brokers
    .map((b) => ({
      nodeId: b.nodeId,
      host: b.host,
      port: b.port,
      rack: (b as { rack?: string }).rack ?? null,
      isController: b.nodeId === cluster.controller,
    }))
    .sort((a, b) => a.nodeId - b.nodeId);
}

export async function getOverview(clusterId: string): Promise<ClusterOverview> {
  const admin = await adminFor(clusterId);
  const config = clusterFor(clusterId);
  const [cluster, topicNames] = await Promise.all([admin.describeCluster(), admin.listTopics()]);
  const metadata = await admin.fetchTopicMetadata({ topics: topicNames });

  let partitionCount = 0;
  let online = 0;
  let underReplicated = 0;
  let offline = 0;
  for (const topic of metadata.topics) {
    for (const p of topic.partitions) {
      partitionCount++;
      if (p.leader >= 0) online++;
      else offline++;
      if (p.isr.length < p.replicas.length) underReplicated++;
    }
  }

  const visible = topicNames.filter((t) => !isInternalTopic(t));
  const totals = await mapLimit(visible, 8, async (topic) => {
    try {
      return countMessages(await topicOffsets(admin, topic));
    } catch {
      return '0';
    }
  });

  let groupCount = 0;
  try {
    groupCount = (await admin.listGroups()).groups.length;
  } catch {
    groupCount = 0;
  }

  return {
    clusterId: cluster.clusterId,
    controllerId: cluster.controller ?? -1,
    brokers: cluster.brokers
      .map((b) => ({
        nodeId: b.nodeId,
        host: b.host,
        port: b.port,
        rack: (b as { rack?: string }).rack ?? null,
        isController: b.nodeId === cluster.controller,
      }))
      .sort((a, b) => a.nodeId - b.nodeId),
    topicCount: visible.length,
    internalTopicCount: topicNames.length - visible.length,
    partitionCount,
    onlinePartitions: online,
    underReplicatedPartitions: underReplicated,
    offlinePartitions: offline,
    consumerGroupCount: groupCount,
    totalMessages: totals.reduce((sum, v) => sum + big(v), 0n).toString(),
    features: {
      schemaRegistry: Boolean(config.schemaRegistry?.url),
      kafkaConnect: (config.connects ?? []).length > 0,
      ksqldb: Boolean(config.ksqldb?.url),
    },
  };
}

export async function getBrokerConfigs(clusterId: string, nodeId: number): Promise<ConfigEntry[]> {
  const admin = await adminFor(clusterId);
  const res = await admin.describeConfigs({
    includeSynonyms: false,
    resources: [{ type: ConfigResourceTypes.BROKER, name: String(nodeId) }],
  });
  return toConfigEntries(res.resources[0]);
}

/* ------------------------------------------------------------------ topics */

export async function listTopics(clusterId: string): Promise<TopicSummary[]> {
  const admin = await adminFor(clusterId);
  const names = await admin.listTopics();
  if (names.length === 0) return [];
  const metadata = await admin.fetchTopicMetadata({ topics: names });
  const configs = await describeTopicConfigs(admin, names).catch(() => new Map<string, ConfigEntry[]>());
  const offsets = await mapLimit(names, 8, async (topic) => {
    try {
      return [topic, await topicOffsets(admin, topic)] as const;
    } catch {
      return [topic, [] as TopicOffsets[]] as const;
    }
  });
  const offsetsByTopic = new Map(offsets);

  return metadata.topics
    .map((topic) => {
      const inSync = topic.partitions.filter((p) => p.isr.length >= p.replicas.length).length;
      const entries = configs.get(topic.name);
      return {
        name: topic.name,
        internal: isInternalTopic(topic.name),
        partitionCount: topic.partitions.length,
        replicationFactor: topic.partitions[0]?.replicas.length ?? 0,
        inSyncReplicas: inSync,
        outOfSyncReplicas: topic.partitions.length - inSync,
        underReplicated: inSync < topic.partitions.length,
        messages: countMessages(offsetsByTopic.get(topic.name) ?? []),
        cleanupPolicy: configValue(entries, 'cleanup.policy', 'delete'),
        retentionMs: configValue(entries, 'retention.ms', '-1'),
      } satisfies TopicSummary;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTopic(clusterId: string, topic: string): Promise<TopicDetail> {
  const admin = await adminFor(clusterId);
  const [metadata, offsets, configs] = await Promise.all([
    withRetry(() => admin.fetchTopicMetadata({ topics: [topic] })),
    topicOffsets(admin, topic),
    describeTopicConfigs(admin, [topic]),
  ]);
  const meta = metadata.topics[0];
  if (!meta) throw new Error(`Topic ${topic} not found`);
  const offsetsByPartition = new Map(offsets.map((o) => [o.partition, o]));

  const partitions: PartitionInfo[] = meta.partitions
    .map((p) => {
      const o = offsetsByPartition.get(p.partitionId);
      const low = o?.low ?? '0';
      const high = o?.high ?? '0';
      return {
        partitionId: p.partitionId,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
        offlineReplicas: (p as { offlineReplicas?: number[] }).offlineReplicas ?? [],
        low,
        high,
        messages: (big(high) - big(low)).toString(),
      };
    })
    .sort((a, b) => a.partitionId - b.partitionId);

  const entries = configs.get(topic) ?? [];
  const inSync = meta.partitions.filter((p) => p.isr.length >= p.replicas.length).length;

  return {
    name: topic,
    internal: isInternalTopic(topic),
    partitionCount: meta.partitions.length,
    replicationFactor: meta.partitions[0]?.replicas.length ?? 0,
    inSyncReplicas: inSync,
    outOfSyncReplicas: meta.partitions.length - inSync,
    underReplicated: inSync < meta.partitions.length,
    messages: countMessages(offsets),
    cleanupPolicy: configValue(entries, 'cleanup.policy', 'delete'),
    retentionMs: configValue(entries, 'retention.ms', '-1'),
    partitions,
    configs: entries,
  };
}

export async function createTopic(clusterId: string, input: CreateTopicInput): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  const topic: ITopicConfig = {
    topic: input.name,
    numPartitions: input.numPartitions,
    replicationFactor: input.replicationFactor,
    configEntries: Object.entries(input.configs ?? {})
      .filter(([, value]) => value !== '')
      .map(([name, value]) => ({ name, value })),
  };
  const created = await admin.createTopics({ topics: [topic], waitForLeaders: true, timeout: 15_000 });
  if (!created) throw new Error(`Topic ${input.name} already exists`);
}

export async function deleteTopic(clusterId: string, topic: string): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.deleteTopics({ topics: [topic], timeout: 15_000 });
}

export async function addPartitions(clusterId: string, topic: string, totalCount: number): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.createPartitions({ topicPartitions: [{ topic, count: totalCount }], timeout: 15_000 });
}

export async function updateTopicConfig(
  clusterId: string,
  topic: string,
  entries: { name: string; value: string }[],
): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.alterConfigs({
    validateOnly: false,
    resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configEntries: entries }],
  });
}

export async function deleteRecords(
  clusterId: string,
  topic: string,
  partitions: { partition: number; offset: string }[],
): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.deleteTopicRecords({ topic, partitions });
}

/* --------------------------------------------------------- consumer groups */

function decodeAssignment(buffer: Buffer | null): { topic: string; partitions: number[] }[] {
  if (!buffer || buffer.length === 0) return [];
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(buffer) as { assignment?: Record<string, number[]> } | null;
    return Object.entries(decoded?.assignment ?? {}).map(([topic, partitions]) => ({ topic, partitions }));
  } catch {
    return [];
  }
}

async function groupLag(admin: Admin, groupId: string, topics: string[]): Promise<{ lag: bigint; offsets: ConsumerGroupOffset[] }> {
  const offsets: ConsumerGroupOffset[] = [];
  let lag = 0n;
  await mapLimit(topics, 6, async (topic) => {
    const [committed, ends] = await Promise.all([
      admin.fetchOffsets({ groupId, topics: [topic] }),
      topicOffsets(admin, topic).catch(() => [] as TopicOffsets[]),
    ]);
    const endByPartition = new Map(ends.map((e) => [e.partition, e.high]));
    for (const t of committed) {
      for (const p of t.partitions) {
        const end = endByPartition.get(p.partition) ?? '0';
        const current = big(p.offset);
        const partitionLag = current < 0n ? 0n : big(end) - current;
        lag += partitionLag > 0n ? partitionLag : 0n;
        offsets.push({
          topic: t.topic,
          partition: p.partition,
          currentOffset: p.offset,
          endOffset: end,
          lag: (partitionLag > 0n ? partitionLag : 0n).toString(),
        });
      }
    }
  });
  offsets.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
  return { lag, offsets };
}

export async function listConsumerGroups(clusterId: string): Promise<ConsumerGroupSummary[]> {
  const admin = await adminFor(clusterId);
  const { groups } = await admin.listGroups();
  if (groups.length === 0) return [];
  const ids = groups.map((g) => g.groupId);
  const described = await admin.describeGroups(ids);

  return await mapLimit(described.groups, 4, async (g) => {
    const membersDetail = g.members.map((m) => ({
      memberId: m.memberId,
      clientId: m.clientId,
      clientHost: m.clientHost,
      assignments: decodeAssignment(m.memberAssignment as unknown as Buffer),
    }));
    const topics = [...new Set(membersDetail.flatMap((m) => m.assignments.map((a) => a.topic)))];
    let lag = '0';
    let coveredTopics = topics;
    try {
      if (coveredTopics.length === 0) {
        const committed = await admin.fetchOffsets({ groupId: g.groupId });
        coveredTopics = committed.map((c) => c.topic);
      }
      lag = (await groupLag(admin, g.groupId, coveredTopics)).lag.toString();
    } catch {
      lag = '-1';
    }
    return {
      groupId: g.groupId,
      state: g.state,
      protocol: g.protocol,
      protocolType: g.protocolType,
      coordinator: -1,
      members: g.members.length,
      topics: coveredTopics.sort(),
      lag,
    } satisfies ConsumerGroupSummary;
  });
}

export async function getConsumerGroup(clusterId: string, groupId: string): Promise<ConsumerGroupDetail> {
  const admin = await adminFor(clusterId);
  const described = await admin.describeGroups([groupId]);
  const g = described.groups[0];
  if (!g) throw new Error(`Consumer group ${groupId} not found`);

  const membersDetail = g.members.map((m) => ({
    memberId: m.memberId,
    clientId: m.clientId,
    clientHost: m.clientHost,
    assignments: decodeAssignment(m.memberAssignment as unknown as Buffer),
  }));

  const committed = await admin.fetchOffsets({ groupId });
  const topics = [...new Set([...committed.map((c) => c.topic), ...membersDetail.flatMap((m) => m.assignments.map((a) => a.topic))])];
  const { lag, offsets } = await groupLag(admin, groupId, topics);

  const ownerByPartition = new Map<string, { memberId: string; clientHost: string }>();
  for (const m of membersDetail) {
    for (const a of m.assignments) {
      for (const p of a.partitions) ownerByPartition.set(`${a.topic}/${p}`, { memberId: m.memberId, clientHost: m.clientHost });
    }
  }

  return {
    groupId: g.groupId,
    state: g.state,
    protocol: g.protocol,
    protocolType: g.protocolType,
    coordinator: -1,
    members: g.members.length,
    topics: topics.sort(),
    lag: lag.toString(),
    membersDetail,
    offsets: offsets.map((o) => ({ ...o, ...ownerByPartition.get(`${o.topic}/${o.partition}`) })),
  };
}

export async function deleteConsumerGroup(clusterId: string, groupId: string): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.deleteGroups([groupId]);
}

export async function resetOffsets(clusterId: string, input: ResetOffsetInput): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  const { groupId, topic, mode, value } = input;

  const all = await topicOffsets(admin, topic);
  const selected = input.partitions?.length ? all.filter((p) => input.partitions!.includes(p.partition)) : all;

  let partitions: { partition: number; offset: string }[];
  switch (mode) {
    case 'earliest':
      partitions = selected.map((p) => ({ partition: p.partition, offset: p.low }));
      break;
    case 'latest':
      partitions = selected.map((p) => ({ partition: p.partition, offset: p.high }));
      break;
    case 'offset':
      partitions = selected.map((p) => ({ partition: p.partition, offset: value ?? p.low }));
      break;
    case 'timestamp': {
      const byTimestamp = await admin.fetchTopicOffsetsByTimestamp(topic, Number(value));
      const wanted = new Set(selected.map((p) => p.partition));
      partitions = byTimestamp
        .filter((p) => wanted.has(p.partition))
        .map((p) => ({ partition: p.partition, offset: p.offset }));
      break;
    }
    default:
      throw new Error(`Unsupported reset mode ${mode}`);
  }
  await admin.setOffsets({ groupId, topic, partitions });
}

/* -------------------------------------------------------------------- acls */

export async function listAcls(clusterId: string): Promise<AclEntry[]> {
  const admin = await adminFor(clusterId);
  const res = await admin.describeAcls({
    resourceType: AclResourceTypes.ANY,
    resourcePatternType: ResourcePatternTypes.ANY,
    permissionType: AclPermissionTypes.ANY,
    operation: AclOperationTypes.ANY,
  });
  const out: AclEntry[] = [];
  for (const resource of res.resources ?? []) {
    for (const acl of resource.acls ?? []) {
      out.push({
        resourceType: String(resource.resourceType),
        resourceName: resource.resourceName,
        resourcePatternType: String(resource.resourcePatternType),
        principal: acl.principal,
        host: acl.host,
        operation: String(acl.operation),
        permissionType: String(acl.permissionType),
      });
    }
  }
  return out.sort(
    (a, b) => a.resourceType.localeCompare(b.resourceType) || a.resourceName.localeCompare(b.resourceName),
  );
}

const asAcl = (entry: AclEntry) => ({
  resourceType: Number(entry.resourceType) as AclResourceTypes,
  resourceName: entry.resourceName,
  resourcePatternType: Number(entry.resourcePatternType) as ResourcePatternTypes,
  principal: entry.principal,
  host: entry.host,
  operation: Number(entry.operation) as AclOperationTypes,
  permissionType: Number(entry.permissionType) as AclPermissionTypes,
});

export async function createAcl(clusterId: string, entry: AclEntry): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.createAcls({ acl: [asAcl(entry)] });
}

export async function deleteAcl(clusterId: string, entry: AclEntry): Promise<void> {
  assertWritable(clusterId);
  const admin = await adminFor(clusterId);
  await admin.deleteAcls({ filters: [asAcl(entry)] });
}

/* ------------------------------------------------------------- connectivity */

export async function testConnection(clusterId: string): Promise<{ brokers: number; clusterId: string }> {
  const admin = await adminFor(clusterId);
  const cluster = await admin.describeCluster();
  return { brokers: cluster.brokers.length, clusterId: cluster.clusterId };
}
