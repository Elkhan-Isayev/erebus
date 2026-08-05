/** Types shared between the Electron main process and the renderer. */

export type ThemeMode = 'light' | 'dark' | 'system';

/** Which broker a connection speaks to. */
export type BrokerKind = 'kafka' | 'rabbitmq';

export type SaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

export interface SaslConfig {
  mechanism: SaslMechanism;
  username: string;
  password: string;
}

export interface SslConfig {
  enabled: boolean;
  rejectUnauthorized: boolean;
  /** PEM contents (not paths) so a config stays portable. */
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
}

export interface SchemaRegistryConfig {
  url: string;
  username?: string;
  password?: string;
}

export interface KafkaConnectConfig {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
}

export interface KsqlDbConfig {
  url: string;
  username?: string;
  password?: string;
}

export interface RabbitConfig {
  /** Management plugin base URL, e.g. http://localhost:15672 */
  url: string;
  username: string;
  password: string;
  vhost: string;
}

export interface ClusterConfig {
  id: string;
  name: string;
  kind: BrokerKind;
  color?: string;
  /** Kafka only. */
  bootstrapServers: string;
  /** RabbitMQ only. */
  rabbit?: RabbitConfig | null;
  clientId?: string;
  readonly: boolean;
  ssl: SslConfig;
  sasl?: SaslConfig | null;
  schemaRegistry?: SchemaRegistryConfig | null;
  connects: KafkaConnectConfig[];
  ksqldb?: KsqlDbConfig | null;
  requestTimeoutMs: number;
  connectionTimeoutMs: number;
  createdAt: number;
}

export interface AppSettings {
  theme: ThemeMode;
  defaultMessageLimit: number;
  showInternalTopics: boolean;
  liveTailBuffer: number;
  /** Saved terminal commands, e.g. kubectl port-forwards. */
  terminals: TerminalProfile[];
}

/** A named command that can open in a terminal tab, optionally on startup. */
export interface TerminalProfile {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  autoStart: boolean;
}

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  command: string;
  status: 'idle' | 'running' | 'exited';
  exitCode: number | null;
  startedAt: number | null;
  createdAt: number;
  profileId?: string;
}

export interface PersistedState {
  clusters: ClusterConfig[];
  settings: AppSettings;
}

/* ------------------------------------------------------------------ cluster */

export interface BrokerInfo {
  nodeId: number;
  host: string;
  port: number;
  rack?: string | null;
  isController: boolean;
}

export interface ClusterOverview {
  clusterId: string;
  controllerId: number;
  brokers: BrokerInfo[];
  topicCount: number;
  internalTopicCount: number;
  partitionCount: number;
  onlinePartitions: number;
  underReplicatedPartitions: number;
  offlinePartitions: number;
  consumerGroupCount: number;
  totalMessages: string;
  version?: string;
  features: {
    schemaRegistry: boolean;
    kafkaConnect: boolean;
    ksqldb: boolean;
  };
}

/* ------------------------------------------------------------------- topics */

export interface PartitionInfo {
  partitionId: number;
  leader: number;
  replicas: number[];
  isr: number[];
  offlineReplicas: number[];
  low: string;
  high: string;
  messages: string;
}

export interface TopicSummary {
  name: string;
  internal: boolean;
  partitionCount: number;
  replicationFactor: number;
  inSyncReplicas: number;
  outOfSyncReplicas: number;
  underReplicated: boolean;
  messages: string;
  cleanupPolicy: string;
  retentionMs: string;
}

export interface TopicDetail extends TopicSummary {
  partitions: PartitionInfo[];
  configs: ConfigEntry[];
}

export interface ConfigEntry {
  name: string;
  value: string | null;
  isDefault: boolean;
  isSensitive: boolean;
  isReadOnly: boolean;
  source?: string;
  documentation?: string | null;
}

export interface CreateTopicInput {
  name: string;
  numPartitions: number;
  replicationFactor: number;
  configs: Record<string, string>;
}

/* ----------------------------------------------------------------- messages */

export type SerdeKind = 'auto' | 'string' | 'json' | 'avro' | 'protobuf' | 'base64' | 'hex' | 'int32' | 'int64';

export interface DecodedPayload {
  /** Human readable rendering used by the UI. */
  text: string | null;
  /** Which decoder actually produced `text`. */
  serde: string;
  /** Confluent wire-format schema id, when present. */
  schemaId?: number;
  size: number;
  error?: string;
}

export interface KafkaMessage {
  id: string;
  topic: string;
  partition: number;
  offset: string;
  timestamp: string;
  timestampType?: number;
  key: DecodedPayload;
  value: DecodedPayload;
  headers: { key: string; value: string }[];
}

export type SeekType = 'latest' | 'earliest' | 'offset' | 'timestamp';

export interface ConsumeQuery {
  clusterId: string;
  topic: string;
  partitions?: number[];
  seek: SeekType;
  /** offset for seek=offset, epoch millis for seek=timestamp */
  seekTo?: string;
  limit: number;
  /** case-insensitive substring match over key + value */
  search?: string;
  /** optional JS predicate body: (key, value, headers, message) => boolean */
  filterExpression?: string;
  keySerde: SerdeKind;
  valueSerde: SerdeKind;
  live: boolean;
  /** streaming session id, generated by the renderer */
  sessionId: string;
}

export interface ConsumeProgress {
  sessionId: string;
  scanned: number;
  matched: number;
  done: boolean;
  error?: string;
  elapsedMs: number;
}

export interface ProduceInput {
  clusterId: string;
  topic: string;
  partition?: number | null;
  key?: string | null;
  value: string | null;
  headers: { key: string; value: string }[];
  keySerde: 'string' | 'json' | 'base64' | 'avro';
  valueSerde: 'string' | 'json' | 'base64' | 'avro';
  /** Schema Registry subject overrides when *Serde is avro. */
  keySubject?: string | null;
  valueSubject?: string | null;
  compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
}

/* ---------------------------------------------------------- consumer groups */

export interface ConsumerGroupSummary {
  groupId: string;
  state: string;
  protocol: string;
  protocolType: string;
  coordinator: number;
  members: number;
  topics: string[];
  lag: string;
}

export interface ConsumerGroupOffset {
  topic: string;
  partition: number;
  currentOffset: string;
  endOffset: string;
  lag: string;
  memberId?: string;
  clientHost?: string;
}

export interface ConsumerGroupMember {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignments: { topic: string; partitions: number[] }[];
}

export interface ConsumerGroupDetail extends ConsumerGroupSummary {
  membersDetail: ConsumerGroupMember[];
  offsets: ConsumerGroupOffset[];
}

export type ResetOffsetMode = 'earliest' | 'latest' | 'offset' | 'timestamp';

export interface ResetOffsetInput {
  clusterId: string;
  groupId: string;
  topic: string;
  partitions?: number[];
  mode: ResetOffsetMode;
  value?: string;
}

/* --------------------------------------------------------------------- acls */

export interface AclEntry {
  resourceType: string;
  resourceName: string;
  resourcePatternType: string;
  principal: string;
  host: string;
  operation: string;
  permissionType: string;
}

/* --------------------------------------------------------- schema registry */

export interface SchemaVersion {
  subject: string;
  version: number;
  id: number;
  schemaType: 'AVRO' | 'JSON' | 'PROTOBUF';
  schema: string;
  compatibility?: string;
}

/* ------------------------------------------------------------ kafka connect */

export interface ConnectorSummary {
  connect: string;
  name: string;
  type: string;
  state: string;
  workerId: string;
  connectorClass: string;
  tasks: { id: number; state: string; workerId: string; trace?: string }[];
  topics: string[];
}

export interface ConnectorDetail extends ConnectorSummary {
  config: Record<string, string>;
}

/* -------------------------------------------------------------------- ksql */

export interface KsqlResponse {
  columns: string[];
  rows: unknown[][];
  raw: unknown;
}

/* --------------------------------------------------------------- rabbitmq */

export interface RabbitOverview {
  clusterName: string;
  version: string;
  erlangVersion: string;
  nodes: { name: string; running: boolean; memUsed: number; memLimit: number; diskFree: number; uptime: number; type: string }[];
  queueTotals: { messages: number; ready: number; unacknowledged: number };
  objectTotals: { queues: number; exchanges: number; connections: number; channels: number; consumers: number };
  messageRates: { publish: number; deliver: number; ack: number; redeliver: number };
  listeners: { protocol: string; port: number; node: string }[];
  vhosts: string[];
}

export interface RabbitQueue {
  name: string;
  vhost: string;
  state: string;
  type: string;
  durable: boolean;
  autoDelete: boolean;
  exclusive: boolean;
  node: string;
  messages: number;
  ready: number;
  unacknowledged: number;
  consumers: number;
  memory: number;
  publishRate: number;
  deliverRate: number;
  arguments: Record<string, unknown>;
  policy?: string | null;
}

export interface RabbitExchange {
  name: string;
  vhost: string;
  type: string;
  durable: boolean;
  autoDelete: boolean;
  internal: boolean;
  arguments: Record<string, unknown>;
  publishInRate: number;
  publishOutRate: number;
}

export interface RabbitBinding {
  source: string;
  destination: string;
  destinationType: string;
  routingKey: string;
  vhost: string;
  arguments: Record<string, unknown>;
  propertiesKey: string;
}

export interface RabbitMessage {
  payload: string;
  payloadBytes: number;
  payloadEncoding: string;
  routingKey: string;
  exchange: string;
  redelivered: boolean;
  messageCount: number;
  properties: Record<string, unknown>;
  headers: Record<string, unknown>;
}

export interface RabbitConnection {
  name: string;
  user: string;
  vhost: string;
  state: string;
  protocol: string;
  peerHost: string;
  peerPort: number;
  channels: number;
  ssl: boolean;
  connectedAt: number;
  clientProperties: Record<string, unknown>;
}

export interface RabbitChannel {
  name: string;
  connection: string;
  user: string;
  vhost: string;
  state: string;
  consumerCount: number;
  unacknowledged: number;
  prefetchCount: number;
  transactional: boolean;
  confirm: boolean;
}

export interface RabbitConsumerInfo {
  queue: string;
  vhost: string;
  channel: string;
  consumerTag: string;
  ackRequired: boolean;
  prefetchCount: number;
  exclusive: boolean;
}

export interface RabbitPublishInput {
  clusterId: string;
  exchange: string;
  routingKey: string;
  payload: string;
  payloadEncoding?: 'string' | 'base64';
  headers?: Record<string, string>;
  properties?: Record<string, unknown>;
}

/* --------------------------------------------------------------------- ipc */

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
