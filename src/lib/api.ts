import type {
  AclEntry,
  AppSettings,
  BrokerInfo,
  ClusterConfig,
  ClusterOverview,
  ConfigEntry,
  ConnectorDetail,
  ConnectorSummary,
  ConsumeQuery,
  ConsumerGroupDetail,
  ConsumerGroupSummary,
  CreateTopicInput,
  KsqlResponse,
  RabbitBinding,
  RabbitChannel,
  RabbitConnection,
  RabbitConsumerInfo,
  RabbitExchange,
  RabbitMessage,
  RabbitOverview,
  RabbitPublishInput,
  RabbitQueue,
  ResetOffsetInput,
  ProduceInput,
  SchemaVersion,
  TerminalProfile,
  TerminalSession,
  TopicDetail,
  TopicSummary,
} from '@shared/types';

type EventChannel =
  | 'consume:messages'
  | 'consume:progress'
  | 'terminal:data'
  | 'terminal:exit'
  | 'terminal:sessions'
  | 'menu:new-terminal'
  | 'menu:toggle-terminal'
  | 'menu:new-cluster'
  | 'menu:refresh'
  | 'menu:toggle-theme'
  | 'menu:palette';

interface Bridge {
  invoke<T>(channel: string, payload?: unknown): Promise<T>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    erebus: Bridge;
  }
}

export const bridge = window.erebus;
const call = <T,>(channel: string, payload?: unknown) => bridge.invoke<T>(channel, payload);

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
  configPath: string;
}

export const api = {
  /* app */
  info: () => call<AppInfo>('app:info'),
  openExternal: (url: string) => call<void>('app:openExternal', { url }),
  copy: (text: string) => call<void>('app:copy', { text }),
  saveFile: (defaultName: string, contents: string) =>
    call<{ saved: boolean; path?: string }>('app:saveFile', { defaultName, contents }),
  openFile: (filters?: { name: string; extensions: string[] }[]) =>
    call<{ opened: boolean; path?: string; contents?: string }>('app:openFile', { filters }),

  /* settings + clusters */
  getSettings: () => call<AppSettings>('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => call<AppSettings>('settings:update', patch),
  listClusters: () => call<ClusterConfig[]>('clusters:list'),
  getCluster: (clusterId: string) => call<ClusterConfig>('clusters:get', { clusterId }),
  saveCluster: (cluster: Partial<ClusterConfig>) => call<ClusterConfig>('clusters:save', cluster),
  deleteCluster: (clusterId: string) => call<boolean>('clusters:delete', { clusterId }),
  testCluster: (clusterId: string) => call<{ brokers: number; clusterId: string }>('clusters:test', { clusterId }),
  exportClusters: () => call<string>('clusters:export'),
  importClusters: (json: string) => call<ClusterConfig[]>('clusters:import', { json }),
  disconnectCluster: (clusterId: string) => call<void>('clusters:disconnect', { clusterId }),

  /* cluster */
  overview: (clusterId: string) => call<ClusterOverview>('cluster:overview', { clusterId }),
  brokers: (clusterId: string) => call<BrokerInfo[]>('cluster:brokers', { clusterId }),
  brokerConfigs: (clusterId: string, nodeId: number) => call<ConfigEntry[]>('cluster:brokerConfigs', { clusterId, nodeId }),

  /* topics */
  topics: (clusterId: string) => call<TopicSummary[]>('topics:list', { clusterId }),
  topic: (clusterId: string, topic: string) => call<TopicDetail>('topics:get', { clusterId, topic }),
  createTopic: (clusterId: string, input: CreateTopicInput) => call<void>('topics:create', { clusterId, input }),
  deleteTopic: (clusterId: string, topic: string) => call<void>('topics:delete', { clusterId, topic }),
  addPartitions: (clusterId: string, topic: string, totalCount: number) =>
    call<void>('topics:addPartitions', { clusterId, topic, totalCount }),
  updateTopicConfig: (clusterId: string, topic: string, entries: { name: string; value: string }[]) =>
    call<void>('topics:updateConfig', { clusterId, topic, entries }),
  purgeTopic: (clusterId: string, topic: string) => call<boolean>('topics:purge', { clusterId, topic }),

  /* messages */
  consume: (query: ConsumeQuery) => call<void>('messages:consume', query),
  stopConsume: (sessionId: string) => call<void>('messages:stop', { sessionId }),
  produce: (input: ProduceInput) => call<{ partition: number; offset: string }[]>('messages:produce', input),

  /* groups */
  groups: (clusterId: string) => call<ConsumerGroupSummary[]>('groups:list', { clusterId }),
  group: (clusterId: string, groupId: string) => call<ConsumerGroupDetail>('groups:get', { clusterId, groupId }),
  deleteGroup: (clusterId: string, groupId: string) => call<void>('groups:delete', { clusterId, groupId }),
  resetOffsets: (input: ResetOffsetInput) => call<void>('groups:resetOffsets', input),

  /* acls */
  acls: (clusterId: string) => call<AclEntry[]>('acls:list', { clusterId }),
  createAcl: (clusterId: string, entry: AclEntry) => call<void>('acls:create', { clusterId, entry }),
  deleteAcl: (clusterId: string, entry: AclEntry) => call<void>('acls:delete', { clusterId, entry }),

  /* schema registry */
  subjects: (clusterId: string) => call<string[]>('schemas:subjects', { clusterId }),
  subjectVersions: (clusterId: string, subject: string) => call<number[]>('schemas:versions', { clusterId, subject }),
  schema: (clusterId: string, subject: string, version: number | 'latest') =>
    call<SchemaVersion>('schemas:get', { clusterId, subject, version }),
  registerSchema: (clusterId: string, subject: string, schema: string, schemaType: SchemaVersion['schemaType']) =>
    call<{ id: number }>('schemas:register', { clusterId, subject, schema, schemaType }),
  deleteSubject: (clusterId: string, subject: string, permanent = false) =>
    call<number[]>('schemas:deleteSubject', { clusterId, subject, permanent }),
  deleteSchemaVersion: (clusterId: string, subject: string, version: number) =>
    call<number>('schemas:deleteVersion', { clusterId, subject, version }),
  setCompatibility: (clusterId: string, subject: string, level: string) =>
    call<{ compatibility: string }>('schemas:setCompatibility', { clusterId, subject, level }),
  checkCompatibility: (clusterId: string, subject: string, schema: string, schemaType: string) =>
    call<{ is_compatible: boolean }>('schemas:checkCompatibility', { clusterId, subject, schema, schemaType }),

  /* kafka connect */
  connectors: (clusterId: string) => call<ConnectorSummary[]>('connect:list', { clusterId }),
  connector: (clusterId: string, connectId: string, name: string) =>
    call<ConnectorDetail>('connect:get', { clusterId, connectId, name }),
  connectorPlugins: (clusterId: string, connectId: string) =>
    call<{ class: string; type: string; version: string }[]>('connect:plugins', { clusterId, connectId }),
  createConnector: (clusterId: string, connectId: string, name: string, config: Record<string, string>) =>
    call<void>('connect:create', { clusterId, connectId, name, config }),
  updateConnectorConfig: (clusterId: string, connectId: string, name: string, config: Record<string, string>) =>
    call<void>('connect:updateConfig', { clusterId, connectId, name, config }),
  deleteConnector: (clusterId: string, connectId: string, name: string) =>
    call<void>('connect:delete', { clusterId, connectId, name }),
  pauseConnector: (clusterId: string, connectId: string, name: string) =>
    call<void>('connect:pause', { clusterId, connectId, name }),
  resumeConnector: (clusterId: string, connectId: string, name: string) =>
    call<void>('connect:resume', { clusterId, connectId, name }),
  restartConnector: (clusterId: string, connectId: string, name: string) =>
    call<void>('connect:restart', { clusterId, connectId, name }),
  restartConnectorTask: (clusterId: string, connectId: string, name: string, taskId: number) =>
    call<void>('connect:restartTask', { clusterId, connectId, name, taskId }),

  /* terminal */
  terminalList: () => call<TerminalSession[]>('terminal:list'),
  terminalCreate: (name?: string, cwd?: string, profileId?: string) =>
    call<TerminalSession>('terminal:create', { name, cwd, profileId }),
  terminalRun: (sessionId: string, command: string) => call<TerminalSession>('terminal:run', { sessionId, command }),
  terminalWrite: (sessionId: string, data: string) => call<void>('terminal:write', { sessionId, data }),
  terminalSignal: (sessionId: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') =>
    call<void>('terminal:signal', { sessionId, signal }),
  terminalClose: (sessionId: string) => call<void>('terminal:close', { sessionId }),
  terminalOutput: (sessionId: string, maxChars?: number) => call<string>('terminal:output', { sessionId, maxChars }),
  terminalRename: (sessionId: string, name: string) => call<void>('terminal:rename', { sessionId, name }),
  terminalProfiles: () => call<TerminalProfile[]>('terminal:profiles'),
  terminalSaveProfile: (profile: Partial<TerminalProfile>) => call<TerminalProfile[]>('terminal:saveProfile', profile),
  terminalDeleteProfile: (profileId: string) => call<TerminalProfile[]>('terminal:deleteProfile', { profileId }),

  /* rabbitmq */
  rabbitOverview: (clusterId: string) => call<RabbitOverview>('rabbit:overview', { clusterId }),
  rabbitQueues: (clusterId: string) => call<RabbitQueue[]>('rabbit:queues', { clusterId }),
  rabbitQueue: (clusterId: string, name: string) =>
    call<RabbitQueue & { bindings: RabbitBinding[] }>('rabbit:queue', { clusterId, name }),
  rabbitCreateQueue: (clusterId: string, name: string, options: { durable?: boolean; autoDelete?: boolean }) =>
    call<void>('rabbit:createQueue', { clusterId, name, options }),
  rabbitDeleteQueue: (clusterId: string, name: string) => call<void>('rabbit:deleteQueue', { clusterId, name }),
  rabbitPurgeQueue: (clusterId: string, name: string) => call<void>('rabbit:purgeQueue', { clusterId, name }),
  rabbitGetMessages: (clusterId: string, queue: string, count: number, requeue: boolean) =>
    call<RabbitMessage[]>('rabbit:getMessages', { clusterId, queue, count, requeue }),
  rabbitPublish: (input: RabbitPublishInput) => call<{ routed: boolean }>('rabbit:publish', input),
  rabbitExchanges: (clusterId: string) => call<RabbitExchange[]>('rabbit:exchanges', { clusterId }),
  rabbitExchange: (clusterId: string, name: string) =>
    call<RabbitExchange & { bindings: RabbitBinding[] }>('rabbit:exchange', { clusterId, name }),
  rabbitCreateExchange: (clusterId: string, name: string, options: { type?: string; durable?: boolean; autoDelete?: boolean }) =>
    call<void>('rabbit:createExchange', { clusterId, name, options }),
  rabbitDeleteExchange: (clusterId: string, name: string) => call<void>('rabbit:deleteExchange', { clusterId, name }),
  rabbitBindings: (clusterId: string) => call<RabbitBinding[]>('rabbit:bindings', { clusterId }),
  rabbitCreateBinding: (
    clusterId: string,
    source: string,
    destination: string,
    options: { destinationType?: 'queue' | 'exchange'; routingKey?: string },
  ) => call<void>('rabbit:createBinding', { clusterId, source, destination, options }),
  rabbitDeleteBinding: (clusterId: string, binding: RabbitBinding) => call<void>('rabbit:deleteBinding', { clusterId, binding }),
  rabbitConnections: (clusterId: string) => call<RabbitConnection[]>('rabbit:connections', { clusterId }),
  rabbitCloseConnection: (clusterId: string, name: string) => call<void>('rabbit:closeConnection', { clusterId, name }),
  rabbitChannels: (clusterId: string) => call<RabbitChannel[]>('rabbit:channels', { clusterId }),
  rabbitConsumers: (clusterId: string) => call<RabbitConsumerInfo[]>('rabbit:consumers', { clusterId }),
  rabbitVhosts: (clusterId: string) => call<string[]>('rabbit:vhosts', { clusterId }),

  /* ksql */
  ksql: (clusterId: string, sql: string) => call<KsqlResponse>('ksql:execute', { clusterId, sql }),
  ksqlStreams: (clusterId: string) => call<KsqlResponse>('ksql:streams', { clusterId }),
  ksqlTables: (clusterId: string) => call<KsqlResponse>('ksql:tables', { clusterId }),
  ksqlQueries: (clusterId: string) => call<KsqlResponse>('ksql:queries', { clusterId }),
  ksqlInfo: (clusterId: string) => call<Record<string, unknown>>('ksql:info', { clusterId }),
};
