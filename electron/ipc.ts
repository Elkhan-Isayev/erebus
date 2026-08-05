import { BrowserWindow, ipcMain, shell, dialog, clipboard, app, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import type {
  AclEntry,
  AppSettings,
  ClusterConfig,
  ConsumeQuery,
  CreateTopicInput,
  IpcResult,
  ProduceInput,
  RabbitBinding,
  RabbitPublishInput,
  ResetOffsetInput,
  TerminalProfile,
  SchemaVersion,
  ThemeMode,
} from '../shared/types';
import * as store from './store';
import * as admin from './kafka/admin';
import * as messages from './kafka/messages';
import * as pool from './kafka/pool';
import * as registry from './rest/schemaRegistry';
import * as connect from './rest/connect';
import * as ksql from './rest/ksql';
import * as rabbit from './rabbit/api';
import * as terminal from './terminal/manager';
import { validateAvroSchema } from './kafka/serde';

type Handler = (payload: any) => unknown | Promise<unknown>;

function emitter(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`erebus:${channel}`, payload);
  }
}

export const handlers: Record<string, Handler> = {
  /* ------------------------------------------------------------- app/store */
  'app:info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    configPath: store.configPath(),
  }),
  'app:openExternal': ({ url }: { url: string }) => shell.openExternal(url),
  'app:copy': ({ text }: { text: string }) => clipboard.writeText(text),
  'app:saveFile': async ({ defaultName, contents }: { defaultName: string; contents: string }) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, { defaultPath: defaultName });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.writeFile(result.filePath, contents, 'utf8');
    return { saved: true, path: result.filePath };
  },
  'app:openFile': async ({ filters }: { filters?: { name: string; extensions: string[] }[] }) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters });
    if (result.canceled || result.filePaths.length === 0) return { opened: false };
    return { opened: true, path: result.filePaths[0], contents: await fs.readFile(result.filePaths[0], 'utf8') };
  },

  'settings:get': () => store.getSettings(),
  'settings:update': (patch: Partial<AppSettings>) => {
    const settings = store.updateSettings(patch);
    if (patch.theme) nativeTheme.themeSource = patch.theme as ThemeMode;
    return settings;
  },

  'clusters:list': () => store.listClusters(),
  'clusters:get': ({ clusterId }: { clusterId: string }) => store.getCluster(clusterId),
  'clusters:save': (cluster: Partial<ClusterConfig>) => {
    const saved = store.upsertCluster(cluster);
    void pool.disconnect(saved.id);
    registry.clearSchemaCache();
    return saved;
  },
  'clusters:delete': async ({ clusterId }: { clusterId: string }) => {
    await pool.disconnect(clusterId);
    store.deleteCluster(clusterId);
    return true;
  },
  'clusters:test': ({ clusterId }: { clusterId: string }) =>
    store.getCluster(clusterId).kind === 'rabbitmq' ? rabbit.testConnection(clusterId) : admin.testConnection(clusterId),
  'clusters:export': () => store.exportClusters(),
  'clusters:import': ({ json }: { json: string }) => store.importClusters(json),
  'clusters:disconnect': ({ clusterId }: { clusterId: string }) => pool.disconnect(clusterId),

  /* --------------------------------------------------------------- cluster */
  'cluster:overview': ({ clusterId }: { clusterId: string }) => admin.getOverview(clusterId),
  'cluster:brokers': ({ clusterId }: { clusterId: string }) => admin.getBrokers(clusterId),
  'cluster:brokerConfigs': ({ clusterId, nodeId }: { clusterId: string; nodeId: number }) =>
    admin.getBrokerConfigs(clusterId, nodeId),

  /* ---------------------------------------------------------------- topics */
  'topics:list': ({ clusterId }: { clusterId: string }) => admin.listTopics(clusterId),
  'topics:get': ({ clusterId, topic }: { clusterId: string; topic: string }) => admin.getTopic(clusterId, topic),
  'topics:create': ({ clusterId, input }: { clusterId: string; input: CreateTopicInput }) =>
    admin.createTopic(clusterId, input),
  'topics:delete': ({ clusterId, topic }: { clusterId: string; topic: string }) => admin.deleteTopic(clusterId, topic),
  'topics:addPartitions': ({ clusterId, topic, totalCount }: { clusterId: string; topic: string; totalCount: number }) =>
    admin.addPartitions(clusterId, topic, totalCount),
  'topics:updateConfig': ({
    clusterId,
    topic,
    entries,
  }: {
    clusterId: string;
    topic: string;
    entries: { name: string; value: string }[];
  }) => admin.updateTopicConfig(clusterId, topic, entries),
  'topics:purge': async ({ clusterId, topic }: { clusterId: string; topic: string }) => {
    const detail = await admin.getTopic(clusterId, topic);
    await admin.deleteRecords(
      clusterId,
      topic,
      detail.partitions.map((p) => ({ partition: p.partitionId, offset: p.high })),
    );
    return true;
  },

  /* -------------------------------------------------------------- messages */
  'messages:consume': (query: ConsumeQuery) => messages.startConsume(query, emitter),
  'messages:consumeBatch': (query: ConsumeQuery) => messages.consumeBatch(query),
  'messages:stop': ({ sessionId }: { sessionId: string }) => messages.stopConsume(sessionId),
  'messages:produce': (input: ProduceInput) => messages.produce(input),

  /* -------------------------------------------------------- consumer groups */
  'groups:list': ({ clusterId }: { clusterId: string }) => admin.listConsumerGroups(clusterId),
  'groups:get': ({ clusterId, groupId }: { clusterId: string; groupId: string }) =>
    admin.getConsumerGroup(clusterId, groupId),
  'groups:delete': ({ clusterId, groupId }: { clusterId: string; groupId: string }) =>
    admin.deleteConsumerGroup(clusterId, groupId),
  'groups:resetOffsets': (input: ResetOffsetInput) => admin.resetOffsets(input.clusterId, input),

  /* ------------------------------------------------------------------ acls */
  'acls:list': ({ clusterId }: { clusterId: string }) => admin.listAcls(clusterId),
  'acls:create': ({ clusterId, entry }: { clusterId: string; entry: AclEntry }) => admin.createAcl(clusterId, entry),
  'acls:delete': ({ clusterId, entry }: { clusterId: string; entry: AclEntry }) => admin.deleteAcl(clusterId, entry),

  /* ------------------------------------------------------- schema registry */
  'schemas:subjects': ({ clusterId }: { clusterId: string }) => registry.listSubjects(clusterId),
  'schemas:versions': ({ clusterId, subject }: { clusterId: string; subject: string }) =>
    registry.listVersions(clusterId, subject),
  'schemas:get': ({ clusterId, subject, version }: { clusterId: string; subject: string; version: number | 'latest' }) =>
    registry.getVersion(clusterId, subject, version),
  'schemas:register': ({
    clusterId,
    subject,
    schema,
    schemaType,
  }: {
    clusterId: string;
    subject: string;
    schema: string;
    schemaType: SchemaVersion['schemaType'];
  }) => registry.registerSchema(clusterId, subject, schema, schemaType),
  'schemas:deleteSubject': ({ clusterId, subject, permanent }: { clusterId: string; subject: string; permanent?: boolean }) =>
    registry.deleteSubject(clusterId, subject, permanent),
  'schemas:deleteVersion': ({ clusterId, subject, version }: { clusterId: string; subject: string; version: number }) =>
    registry.deleteVersion(clusterId, subject, version),
  'schemas:setCompatibility': ({ clusterId, subject, level }: { clusterId: string; subject: string; level: string }) =>
    registry.setCompatibility(clusterId, subject, level),
  'schemas:checkCompatibility': ({
    clusterId,
    subject,
    schema,
    schemaType,
  }: {
    clusterId: string;
    subject: string;
    schema: string;
    schemaType: string;
  }) => registry.checkCompatibility(clusterId, subject, schema, schemaType),
  'schemas:validate': ({ schema }: { schema: string }) => validateAvroSchema(schema),

  /* ---------------------------------------------------------- kafka connect */
  'connect:list': ({ clusterId }: { clusterId: string }) => connect.listConnectors(clusterId),
  'connect:get': ({ clusterId, connectId, name }: { clusterId: string; connectId: string; name: string }) =>
    connect.getConnector(clusterId, connectId, name),
  'connect:plugins': ({ clusterId, connectId }: { clusterId: string; connectId: string }) =>
    connect.connectorPlugins(clusterId, connectId),
  'connect:create': ({
    clusterId,
    connectId,
    name,
    config,
  }: {
    clusterId: string;
    connectId: string;
    name: string;
    config: Record<string, string>;
  }) => connect.createConnector(clusterId, connectId, name, config),
  'connect:updateConfig': ({
    clusterId,
    connectId,
    name,
    config,
  }: {
    clusterId: string;
    connectId: string;
    name: string;
    config: Record<string, string>;
  }) => connect.updateConnectorConfig(clusterId, connectId, name, config),
  'connect:delete': ({ clusterId, connectId, name }: { clusterId: string; connectId: string; name: string }) =>
    connect.deleteConnector(clusterId, connectId, name),
  'connect:pause': ({ clusterId, connectId, name }: { clusterId: string; connectId: string; name: string }) =>
    connect.pauseConnector(clusterId, connectId, name),
  'connect:resume': ({ clusterId, connectId, name }: { clusterId: string; connectId: string; name: string }) =>
    connect.resumeConnector(clusterId, connectId, name),
  'connect:restart': ({ clusterId, connectId, name }: { clusterId: string; connectId: string; name: string }) =>
    connect.restartConnector(clusterId, connectId, name),
  'connect:restartTask': ({
    clusterId,
    connectId,
    name,
    taskId,
  }: {
    clusterId: string;
    connectId: string;
    name: string;
    taskId: number;
  }) => connect.restartTask(clusterId, connectId, name, taskId),

  /* -------------------------------------------------------------- terminal */
  'terminal:list': () => terminal.listSessions(),
  'terminal:create': ({ name, cwd, profileId }: { name?: string; cwd?: string; profileId?: string }) =>
    terminal.createSession({ name, cwd, profileId }),
  'terminal:run': ({ sessionId, command }: { sessionId: string; command: string }) => terminal.run(sessionId, command),
  'terminal:write': ({ sessionId, data }: { sessionId: string; data: string }) => terminal.write(sessionId, data),
  'terminal:signal': ({ sessionId, signal }: { sessionId: string; signal?: NodeJS.Signals }) =>
    terminal.signal(sessionId, signal),
  'terminal:close': ({ sessionId }: { sessionId: string }) => terminal.closeSession(sessionId),
  'terminal:output': ({ sessionId, maxChars }: { sessionId: string; maxChars?: number }) =>
    terminal.output(sessionId, maxChars),
  'terminal:rename': ({ sessionId, name }: { sessionId: string; name: string }) => terminal.rename(sessionId, name),
  'terminal:profiles': () => store.getSettings().terminals ?? [],
  'terminal:saveProfile': (profile: TerminalProfile) => {
    const profiles = store.getSettings().terminals ?? [];
    const id = profile.id || crypto.randomUUID();
    const next = profiles.some((p) => p.id === id)
      ? profiles.map((p) => (p.id === id ? { ...p, ...profile, id } : p))
      : [...profiles, { ...profile, id }];
    store.updateSettings({ terminals: next });
    return next;
  },
  'terminal:deleteProfile': ({ profileId }: { profileId: string }) => {
    const next = (store.getSettings().terminals ?? []).filter((p) => p.id !== profileId);
    store.updateSettings({ terminals: next });
    return next;
  },

  /* -------------------------------------------------------------- rabbitmq */
  'rabbit:overview': ({ clusterId }: { clusterId: string }) => rabbit.overview(clusterId),
  'rabbit:queues': ({ clusterId }: { clusterId: string }) => rabbit.listQueues(clusterId),
  'rabbit:queue': ({ clusterId, name }: { clusterId: string; name: string }) => rabbit.getQueue(clusterId, name),
  'rabbit:createQueue': ({
    clusterId,
    name,
    options,
  }: {
    clusterId: string;
    name: string;
    options?: { durable?: boolean; autoDelete?: boolean; arguments?: Record<string, unknown> };
  }) => rabbit.createQueue(clusterId, name, options),
  'rabbit:deleteQueue': ({ clusterId, name }: { clusterId: string; name: string }) => rabbit.deleteQueue(clusterId, name),
  'rabbit:purgeQueue': ({ clusterId, name }: { clusterId: string; name: string }) => rabbit.purgeQueue(clusterId, name),
  'rabbit:getMessages': ({
    clusterId,
    queue,
    count,
    requeue,
  }: {
    clusterId: string;
    queue: string;
    count?: number;
    requeue?: boolean;
  }) => rabbit.getMessages(clusterId, queue, { count, requeue }),
  'rabbit:publish': (input: RabbitPublishInput) => rabbit.publish(input),
  'rabbit:exchanges': ({ clusterId }: { clusterId: string }) => rabbit.listExchanges(clusterId),
  'rabbit:exchange': ({ clusterId, name }: { clusterId: string; name: string }) => rabbit.getExchange(clusterId, name),
  'rabbit:createExchange': ({
    clusterId,
    name,
    options,
  }: {
    clusterId: string;
    name: string;
    options?: { type?: string; durable?: boolean; autoDelete?: boolean; internal?: boolean };
  }) => rabbit.createExchange(clusterId, name, options),
  'rabbit:deleteExchange': ({ clusterId, name }: { clusterId: string; name: string }) =>
    rabbit.deleteExchange(clusterId, name),
  'rabbit:bindings': ({ clusterId }: { clusterId: string }) => rabbit.listBindings(clusterId),
  'rabbit:createBinding': ({
    clusterId,
    source,
    destination,
    options,
  }: {
    clusterId: string;
    source: string;
    destination: string;
    options?: { destinationType?: 'queue' | 'exchange'; routingKey?: string };
  }) => rabbit.createBinding(clusterId, source, destination, options),
  'rabbit:deleteBinding': ({ clusterId, binding }: { clusterId: string; binding: RabbitBinding }) =>
    rabbit.deleteBinding(clusterId, binding),
  'rabbit:connections': ({ clusterId }: { clusterId: string }) => rabbit.listConnections(clusterId),
  'rabbit:closeConnection': ({ clusterId, name }: { clusterId: string; name: string }) =>
    rabbit.closeConnection(clusterId, name),
  'rabbit:channels': ({ clusterId }: { clusterId: string }) => rabbit.listChannels(clusterId),
  'rabbit:consumers': ({ clusterId }: { clusterId: string }) => rabbit.listConsumers(clusterId),
  'rabbit:vhosts': ({ clusterId }: { clusterId: string }) => rabbit.listVhosts(clusterId),

  /* ------------------------------------------------------------------ ksql */
  'ksql:execute': ({ clusterId, sql }: { clusterId: string; sql: string }) => ksql.execute(clusterId, sql),
  'ksql:streams': ({ clusterId }: { clusterId: string }) => ksql.listStreams(clusterId),
  'ksql:tables': ({ clusterId }: { clusterId: string }) => ksql.listTables(clusterId),
  'ksql:queries': ({ clusterId }: { clusterId: string }) => ksql.listQueries(clusterId),
  'ksql:info': ({ clusterId }: { clusterId: string }) => ksql.info(clusterId),
};

export function registerIpc(): void {
  terminal.setEmitter(emitter);

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`erebus:${channel}`, async (_event, payload): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, data: (await handler(payload ?? {})) ?? null };
      } catch (err) {
        const error = err as Error & { type?: string };
        const detail = error.type ? `${error.type}: ${error.message}` : error.message;
        return { ok: false, error: detail || 'Unknown error' };
      }
    });
  }
}
