/**
 * Tool catalogue exposed over MCP. Every tool delegates to the same handlers the UI
 * uses, so the agent and the app can never drift apart.
 */
import { handlers } from '../ipc';

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  /** Mutating tools are hidden when EREBUS_MCP_READONLY is set. */
  write?: boolean;
  run: (args: Record<string, any>) => unknown | Promise<unknown>;
}

const call = (channel: string, payload?: unknown) => handlers[channel](payload ?? {});

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });
const CLUSTER = str('Cluster id from list_clusters');

export const TOOLS: McpTool[] = [
  {
    name: 'list_clusters',
    description:
      'List every broker connection configured in Erebus: id, name, kind (kafka or rabbitmq), endpoint, read-only flag and which integrations (Schema Registry, Kafka Connect, ksqlDB) are attached. Start here — every other tool needs a cluster id.',
    inputSchema: object({}),
    run: async () => {
      const clusters = (await call('clusters:list')) as any[];
      return clusters.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        endpoint: c.kind === 'rabbitmq' ? `${c.rabbit?.url} (vhost ${c.rabbit?.vhost})` : c.bootstrapServers,
        bootstrapServers: c.kind === 'rabbitmq' ? undefined : c.bootstrapServers,
        readonly: c.readonly,
        security: c.sasl ? `SASL ${c.sasl.mechanism}` : 'PLAINTEXT',
        tls: Boolean(c.ssl?.enabled),
        schemaRegistry: c.schemaRegistry?.url ?? null,
        kafkaConnect: (c.connects ?? []).map((k: any) => ({ id: k.id, name: k.name, url: k.url })),
        ksqldb: c.ksqldb?.url ?? null,
      }));
    },
  },
  {
    name: 'add_cluster',
    description:
      'Register a broker connection, or update an existing one by passing its id. Set kind to "rabbitmq" and pass managementUrl for RabbitMQ. The connection is saved in the Erebus desktop app and shows up in its UI immediately.',
    inputSchema: object(
      {
        name: str('Display name'),
        kind: { type: 'string', enum: ['kafka', 'rabbitmq'], description: 'Broker type (default kafka)' },
        bootstrapServers: str('Kafka: comma separated host:port list'),
        managementUrl: str('RabbitMQ: management plugin URL, e.g. http://localhost:15672'),
        vhost: str('RabbitMQ: virtual host (default /)'),
        id: str('Existing cluster id to update; omit to create a new one'),
        readonly: bool('Block every write on this cluster (default false)'),
        saslMechanism: str('plain | scram-sha-256 | scram-sha-512'),
        username: str('SASL username'),
        password: str('SASL password'),
        tls: bool('Connect over TLS'),
        schemaRegistryUrl: str('Schema Registry base URL'),
        ksqldbUrl: str('ksqlDB server URL'),
        connectUrl: str('Kafka Connect REST URL'),
      },
      ['name'],
    ),
    write: true,
    run: async (args) => {
      const kind = args.kind ?? 'kafka';
      if (kind === 'rabbitmq' && !args.managementUrl) throw new Error('managementUrl is required for RabbitMQ');
      if (kind === 'kafka' && !args.bootstrapServers) throw new Error('bootstrapServers is required for Kafka');
      const saved = (await call('clusters:save', {
        id: args.id,
        name: args.name,
        kind,
        rabbit:
          kind === 'rabbitmq'
            ? {
                url: args.managementUrl,
                username: args.username ?? 'guest',
                password: args.password ?? 'guest',
                vhost: args.vhost || '/',
              }
            : null,
        bootstrapServers: args.bootstrapServers ?? 'localhost:9092',
        readonly: args.readonly ?? false,
        ssl: { enabled: Boolean(args.tls), rejectUnauthorized: true },
        sasl: args.saslMechanism
          ? { mechanism: args.saslMechanism, username: args.username ?? '', password: args.password ?? '' }
          : null,
        schemaRegistry: args.schemaRegistryUrl ? { url: args.schemaRegistryUrl } : null,
        ksqldb: args.ksqldbUrl ? { url: args.ksqldbUrl } : null,
        connects: args.connectUrl ? [{ id: crypto.randomUUID(), name: 'connect', url: args.connectUrl }] : [],
      })) as any;
      return { id: saved.id, name: saved.name, kind: saved.kind, endpoint: saved.rabbit?.url ?? saved.bootstrapServers };
    },
  },
  {
    name: 'remove_cluster',
    description: 'Forget a broker connection. Nothing on the cluster itself is touched.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    write: true,
    run: async ({ clusterId }) => {
      await call('clusters:delete', { clusterId });
      return { removed: clusterId };
    },
  },
  {
    name: 'test_cluster',
    description: 'Open a connection and report how many brokers answered — use it to verify credentials and reachability.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('clusters:test', { clusterId }),
  },
  {
    name: 'cluster_overview',
    description:
      'Health summary of a cluster: broker list, controller, topic and partition counts, under-replicated and offline partitions, consumer group count and total message count.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('cluster:overview', { clusterId }),
  },
  {
    name: 'list_brokers',
    description: 'List the brokers of a cluster with node id, host, port, rack and which one is the controller.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('cluster:brokers', { clusterId }),
  },
  {
    name: 'get_broker_config',
    description: 'Effective configuration of one broker. Use `filter` to narrow the keys.',
    inputSchema: object(
      { clusterId: CLUSTER, nodeId: num('Broker node id'), filter: str('Optional substring filter over config keys') },
      ['clusterId', 'nodeId'],
    ),
    run: async ({ clusterId, nodeId, filter }) => {
      const configs = (await call('cluster:brokerConfigs', { clusterId, nodeId })) as any[];
      return filter ? configs.filter((c) => c.name.includes(filter)) : configs;
    },
  },

  /* ---------------------------------------------------------------- topics */
  {
    name: 'list_topics',
    description:
      'List topics with partition count, replication factor, out-of-sync replicas, message count, cleanup policy and retention.',
    inputSchema: object({
      clusterId: CLUSTER,
      filter: str('Optional substring filter over topic names'),
      includeInternal: bool('Include internal topics such as __consumer_offsets (default false)'),
    }, ['clusterId']),
    run: async ({ clusterId, filter, includeInternal }) => {
      const topics = (await call('topics:list', { clusterId })) as any[];
      return topics.filter(
        (t) => (includeInternal || !t.internal) && (!filter || t.name.toLowerCase().includes(String(filter).toLowerCase())),
      );
    },
  },
  {
    name: 'describe_topic',
    description: 'Full detail of one topic: per-partition leader, replicas, ISR, earliest/latest offsets, and its configuration.',
    inputSchema: object({ clusterId: CLUSTER, topic: str('Topic name') }, ['clusterId', 'topic']),
    run: ({ clusterId, topic }) => call('topics:get', { clusterId, topic }),
  },
  {
    name: 'create_topic',
    description: 'Create a topic. Rejected when the cluster is marked read-only.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        name: str('Topic name'),
        partitions: num('Number of partitions (default 1)'),
        replicationFactor: num('Replication factor (default 1)'),
        configs: { type: 'object', description: 'Topic configuration entries, e.g. {"retention.ms":"604800000"}' },
      },
      ['clusterId', 'name'],
    ),
    write: true,
    run: async ({ clusterId, name, partitions, replicationFactor, configs }) => {
      await call('topics:create', {
        clusterId,
        input: {
          name,
          numPartitions: partitions ?? 1,
          replicationFactor: replicationFactor ?? 1,
          configs: configs ?? {},
        },
      });
      return { created: name };
    },
  },
  {
    name: 'delete_topic',
    description: 'Delete a topic and every message in it. Irreversible.',
    inputSchema: object({ clusterId: CLUSTER, topic: str('Topic name') }, ['clusterId', 'topic']),
    write: true,
    run: async ({ clusterId, topic }) => {
      await call('topics:delete', { clusterId, topic });
      return { deleted: topic };
    },
  },
  {
    name: 'update_topic_config',
    description: 'Change topic configuration entries, e.g. retention.ms or cleanup.policy.',
    inputSchema: object(
      { clusterId: CLUSTER, topic: str('Topic name'), configs: { type: 'object', description: 'Entries to set' } },
      ['clusterId', 'topic', 'configs'],
    ),
    write: true,
    run: async ({ clusterId, topic, configs }) => {
      await call('topics:updateConfig', {
        clusterId,
        topic,
        entries: Object.entries(configs).map(([name, value]) => ({ name, value: String(value) })),
      });
      return { updated: Object.keys(configs) };
    },
  },
  {
    name: 'add_partitions',
    description: 'Grow a topic to `totalCount` partitions. Partitions can never be removed.',
    inputSchema: object({ clusterId: CLUSTER, topic: str('Topic name'), totalCount: num('New total partition count') }, [
      'clusterId',
      'topic',
      'totalCount',
    ]),
    write: true,
    run: async (args) => {
      await call('topics:addPartitions', args);
      return { topic: args.topic, partitions: args.totalCount };
    },
  },
  {
    name: 'purge_topic',
    description: 'Delete all records up to the current end offset, keeping the topic and its configuration.',
    inputSchema: object({ clusterId: CLUSTER, topic: str('Topic name') }, ['clusterId', 'topic']),
    write: true,
    run: async ({ clusterId, topic }) => {
      await call('topics:purge', { clusterId, topic });
      return { purged: topic };
    },
  },

  /* -------------------------------------------------------------- messages */
  {
    name: 'consume_messages',
    description:
      'Read messages from a topic and return them decoded. Seek from the newest, the oldest, a given offset or a timestamp; narrow with a substring search or a JavaScript predicate over the parsed value. Avro payloads are decoded through the Schema Registry when one is configured.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        topic: str('Topic name'),
        seek: { type: 'string', enum: ['latest', 'earliest', 'offset', 'timestamp'], description: 'Where to start (default latest)' },
        seekTo: str('Offset when seek=offset, epoch milliseconds when seek=timestamp'),
        limit: num('Maximum messages to return (default 20)'),
        partitions: { type: 'array', items: { type: 'number' }, description: 'Restrict to these partitions' },
        search: str('Case-insensitive substring that must appear in key, value or headers'),
        filter: str("JavaScript predicate over (key, value, headers, message), e.g. \"value.status === 'FAILED'\""),
        keySerde: str('auto | string | json | avro | base64 | hex | int32 | int64 (default auto)'),
        valueSerde: str('auto | string | json | avro | base64 | hex | int32 | int64 (default auto)'),
      },
      ['clusterId', 'topic'],
    ),
    run: async (args) => {
      const result = (await call('messages:consumeBatch', {
        clusterId: args.clusterId,
        topic: args.topic,
        seek: args.seek ?? 'latest',
        seekTo: args.seekTo,
        limit: args.limit ?? 20,
        partitions: args.partitions,
        search: args.search,
        filterExpression: args.filter,
        keySerde: args.keySerde ?? 'auto',
        valueSerde: args.valueSerde ?? 'auto',
        live: false,
        sessionId: '',
      })) as { messages: any[]; scanned: number; elapsedMs: number };
      return {
        returned: result.messages.length,
        scanned: result.scanned,
        elapsedMs: result.elapsedMs,
        messages: result.messages.map((m) => ({
          partition: m.partition,
          offset: m.offset,
          timestamp: new Date(Number(m.timestamp)).toISOString(),
          key: m.key.text,
          value: m.value.text,
          headers: Object.fromEntries(m.headers.map((h: any) => [h.key, h.value])),
          serde: { key: m.key.serde, value: m.value.serde, schemaId: m.value.schemaId },
        })),
      };
    },
  },
  {
    name: 'produce_message',
    description:
      'Publish a message to a topic. Use valueSerde "avro" together with valueSubject to serialise through the Schema Registry.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        topic: str('Topic name'),
        value: str('Message value; JSON text when valueSerde is json or avro'),
        key: str('Message key (omit for a null key)'),
        headers: { type: 'object', description: 'Headers as a flat string map' },
        partition: num('Target partition; omit to let Kafka choose'),
        keySerde: str('string | json | base64 | avro (default string)'),
        valueSerde: str('string | json | base64 | avro (default string)'),
        keySubject: str('Schema Registry subject when keySerde is avro'),
        valueSubject: str('Schema Registry subject when valueSerde is avro'),
        compression: str('none | gzip | snappy | lz4 | zstd'),
      },
      ['clusterId', 'topic', 'value'],
    ),
    write: true,
    run: async (args) =>
      call('messages:produce', {
        clusterId: args.clusterId,
        topic: args.topic,
        value: args.value,
        key: args.key ?? null,
        headers: Object.entries(args.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        partition: args.partition ?? null,
        keySerde: args.keySerde ?? 'string',
        valueSerde: args.valueSerde ?? 'string',
        keySubject: args.keySubject ?? null,
        valueSubject: args.valueSubject ?? null,
        compression: args.compression ?? 'none',
      }),
  },

  /* ------------------------------------------------------- consumer groups */
  {
    name: 'list_consumer_groups',
    description: 'List consumer groups with state, member count, subscribed topics and total lag.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('groups:list', { clusterId }),
  },
  {
    name: 'describe_consumer_group',
    description: 'Members, assignments and per-partition committed offset, end offset and lag for one group.',
    inputSchema: object({ clusterId: CLUSTER, groupId: str('Consumer group id') }, ['clusterId', 'groupId']),
    run: (args) => call('groups:get', args),
  },
  {
    name: 'reset_consumer_group_offsets',
    description:
      'Move a group to the earliest or latest offset, a specific offset, or a timestamp. The group must have no active members.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        groupId: str('Consumer group id'),
        topic: str('Topic name'),
        mode: { type: 'string', enum: ['earliest', 'latest', 'offset', 'timestamp'], description: 'Reset strategy' },
        value: str('Offset when mode=offset, epoch milliseconds when mode=timestamp'),
        partitions: { type: 'array', items: { type: 'number' }, description: 'Restrict to these partitions' },
      },
      ['clusterId', 'groupId', 'topic', 'mode'],
    ),
    write: true,
    run: async (args) => {
      await call('groups:resetOffsets', args);
      return { reset: `${args.groupId} → ${args.topic} (${args.mode})` };
    },
  },
  {
    name: 'delete_consumer_group',
    description: 'Delete a consumer group and its committed offsets.',
    inputSchema: object({ clusterId: CLUSTER, groupId: str('Consumer group id') }, ['clusterId', 'groupId']),
    write: true,
    run: async (args) => {
      await call('groups:delete', args);
      return { deleted: args.groupId };
    },
  },

  /* -------------------------------------------------------- schema registry */
  {
    name: 'list_schema_subjects',
    description: 'List Schema Registry subjects for a cluster.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('schemas:subjects', { clusterId }),
  },
  {
    name: 'get_schema',
    description: 'Fetch a subject version (default latest) with its id, type, compatibility level and schema text.',
    inputSchema: object(
      { clusterId: CLUSTER, subject: str('Subject name'), version: str('Version number or "latest"') },
      ['clusterId', 'subject'],
    ),
    run: ({ clusterId, subject, version }) =>
      call('schemas:get', { clusterId, subject, version: version && version !== 'latest' ? Number(version) : 'latest' }),
  },
  {
    name: 'register_schema',
    description: 'Register a new schema version under a subject.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        subject: str('Subject name'),
        schema: str('Schema text'),
        schemaType: { type: 'string', enum: ['AVRO', 'JSON', 'PROTOBUF'], description: 'Schema type (default AVRO)' },
      },
      ['clusterId', 'subject', 'schema'],
    ),
    write: true,
    run: (args) => call('schemas:register', { ...args, schemaType: args.schemaType ?? 'AVRO' }),
  },

  /* ------------------------------------------------------------ connect */
  {
    name: 'list_connectors',
    description: 'List Kafka Connect connectors across every configured Connect worker, with state and task health.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('connect:list', { clusterId }),
  },
  {
    name: 'get_connector',
    description: 'Status, tasks, failure traces and configuration of one connector.',
    inputSchema: object(
      { clusterId: CLUSTER, connectId: str('Connect worker id or name'), name: str('Connector name') },
      ['clusterId', 'connectId', 'name'],
    ),
    run: (args) => call('connect:get', args),
  },
  {
    name: 'control_connector',
    description: 'Pause, resume, restart or delete a connector.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        connectId: str('Connect worker id or name'),
        name: str('Connector name'),
        action: { type: 'string', enum: ['pause', 'resume', 'restart', 'delete'], description: 'What to do' },
      },
      ['clusterId', 'connectId', 'name', 'action'],
    ),
    write: true,
    run: async ({ clusterId, connectId, name, action }) => {
      const channel = { pause: 'connect:pause', resume: 'connect:resume', restart: 'connect:restart', delete: 'connect:delete' }[
        action as string
      ];
      if (!channel) throw new Error(`Unknown action ${action}`);
      await call(channel, { clusterId, connectId, name });
      return { connector: name, action };
    },
  },

  /* --------------------------------------------------------------- ksqldb */
  {
    name: 'ksql_execute',
    description: 'Run a ksqlDB statement — SHOW, DESCRIBE, CREATE, DROP, TERMINATE or SELECT — and return the rows.',
    inputSchema: object({ clusterId: CLUSTER, sql: str('The statement to run') }, ['clusterId', 'sql']),
    write: true,
    run: async ({ clusterId, sql }) => {
      const result = (await call('ksql:execute', { clusterId, sql })) as any;
      return { columns: result.columns, rows: result.rows };
    },
  },


  /* -------------------------------------------------------------- rabbitmq */
  {
    name: 'rabbit_overview',
    description: 'RabbitMQ: broker version, nodes, message totals, object counts and message rates.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('rabbit:overview', { clusterId }),
  },
  {
    name: 'rabbit_list_queues',
    description: 'RabbitMQ: queues in the configured vhost with ready/unacked counts, consumers and rates.',
    inputSchema: object({ clusterId: CLUSTER, filter: str('Optional substring filter over queue names') }, ['clusterId']),
    run: async ({ clusterId, filter }) => {
      const queues = (await call('rabbit:queues', { clusterId })) as any[];
      return filter ? queues.filter((q) => q.name.toLowerCase().includes(String(filter).toLowerCase())) : queues;
    },
  },
  {
    name: 'rabbit_describe_queue',
    description: 'RabbitMQ: one queue with its bindings, arguments, state and counters.',
    inputSchema: object({ clusterId: CLUSTER, name: str('Queue name') }, ['clusterId', 'name']),
    run: (args) => call('rabbit:queue', args),
  },
  {
    name: 'rabbit_get_messages',
    description:
      'RabbitMQ: read messages from the head of a queue. requeue=true (default) puts them back — set it to false to consume and acknowledge them.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        queue: str('Queue name'),
        count: num('How many messages to fetch (default 10)'),
        requeue: bool('Put the messages back on the queue (default true)'),
      },
      ['clusterId', 'queue'],
    ),
    run: ({ clusterId, queue, count, requeue }) =>
      call('rabbit:getMessages', { clusterId, queue, count: count ?? 10, requeue: requeue ?? true }),
  },
  {
    name: 'rabbit_publish',
    description:
      'RabbitMQ: publish a message. Leave exchange empty to use the default exchange, where routingKey is the queue name. The reply says whether the message was routed anywhere.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        routingKey: str('Routing key, or the queue name on the default exchange'),
        payload: str('Message body'),
        exchange: str('Exchange name; empty for the default exchange'),
        headers: { type: 'object', description: 'Headers as a flat string map' },
        properties: { type: 'object', description: 'AMQP properties, e.g. {"content_type":"application/json"}' },
      },
      ['clusterId', 'routingKey', 'payload'],
    ),
    write: true,
    run: (args) =>
      call('rabbit:publish', {
        clusterId: args.clusterId,
        exchange: args.exchange ?? '',
        routingKey: args.routingKey,
        payload: args.payload,
        headers: args.headers ?? {},
        properties: args.properties ?? {},
      }),
  },
  {
    name: 'rabbit_manage_queue',
    description: 'RabbitMQ: create, purge or delete a queue.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        name: str('Queue name'),
        action: { type: 'string', enum: ['create', 'purge', 'delete'], description: 'What to do' },
        durable: bool('create only: survive a broker restart (default true)'),
      },
      ['clusterId', 'name', 'action'],
    ),
    write: true,
    run: async ({ clusterId, name, action, durable }) => {
      if (action === 'create') await call('rabbit:createQueue', { clusterId, name, options: { durable: durable ?? true } });
      else if (action === 'purge') await call('rabbit:purgeQueue', { clusterId, name });
      else if (action === 'delete') await call('rabbit:deleteQueue', { clusterId, name });
      else throw new Error(`Unknown action ${action}`);
      return { queue: name, action };
    },
  },
  {
    name: 'rabbit_list_exchanges',
    description: 'RabbitMQ: exchanges in the configured vhost with type and rates.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('rabbit:exchanges', { clusterId }),
  },
  {
    name: 'rabbit_manage_exchange',
    description: 'RabbitMQ: create or delete an exchange.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        name: str('Exchange name'),
        action: { type: 'string', enum: ['create', 'delete'], description: 'What to do' },
        type: str('create only: direct | fanout | topic | headers (default topic)'),
      },
      ['clusterId', 'name', 'action'],
    ),
    write: true,
    run: async ({ clusterId, name, action, type }) => {
      if (action === 'create') await call('rabbit:createExchange', { clusterId, name, options: { type: type ?? 'topic' } });
      else await call('rabbit:deleteExchange', { clusterId, name });
      return { exchange: name, action };
    },
  },
  {
    name: 'rabbit_list_bindings',
    description: 'RabbitMQ: every binding in the vhost — which exchange routes to which queue on which routing key.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('rabbit:bindings', { clusterId }),
  },
  {
    name: 'rabbit_bind',
    description: 'RabbitMQ: bind a queue (or another exchange) to an exchange with a routing key.',
    inputSchema: object(
      {
        clusterId: CLUSTER,
        source: str('Source exchange'),
        destination: str('Destination queue or exchange'),
        routingKey: str('Routing key'),
        destinationType: { type: 'string', enum: ['queue', 'exchange'], description: 'Default queue' },
      },
      ['clusterId', 'source', 'destination'],
    ),
    write: true,
    run: async (args) => {
      await call('rabbit:createBinding', {
        clusterId: args.clusterId,
        source: args.source,
        destination: args.destination,
        options: { routingKey: args.routingKey ?? '', destinationType: args.destinationType ?? 'queue' },
      });
      return { bound: `${args.source} → ${args.destination}` };
    },
  },
  {
    name: 'rabbit_list_connections',
    description: 'RabbitMQ: connected clients, with peer, user, vhost and channel count.',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('rabbit:connections', { clusterId }),
  },

  /* -------------------------------------------------------------- terminal */
  {
    name: 'terminal_list',
    description:
      'List the terminal tabs open in Erebus, with the command each one runs and whether it is still running. Use it to check on port-forwards.',
    inputSchema: object({}),
    run: () => call('terminal:list'),
  },
  {
    name: 'terminal_run',
    description:
      'Open a terminal tab in Erebus and run a command in it — for example `kubectl port-forward svc/kafka 9092:9092`. Long-running commands keep streaming; read them back with terminal_output. Pass sessionId to reuse an existing idle tab.',
    inputSchema: object(
      {
        command: str('The command to run through the login shell'),
        name: str('Tab name'),
        cwd: str('Working directory (defaults to the home directory)'),
        sessionId: str('Reuse this session instead of opening a new tab'),
      },
      ['command'],
    ),
    write: true,
    run: async ({ command, name, cwd, sessionId }) => {
      const id =
        sessionId ?? ((await call('terminal:create', { name: name ?? command.split(' ')[0], cwd })) as any).id;
      const session = (await call('terminal:run', { sessionId: id, command })) as any;
      // Give the process a moment so the first output is already there.
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { ...session, output: await call('terminal:output', { sessionId: id, maxChars: 4000 }) };
    },
  },
  {
    name: 'terminal_output',
    description: 'Read the scrollback of a terminal tab.',
    inputSchema: object({ sessionId: str('Session id from terminal_list'), maxChars: num('How much to return (default 8000)') }, [
      'sessionId',
    ]),
    run: ({ sessionId, maxChars }) => call('terminal:output', { sessionId, maxChars: maxChars ?? 8000 }),
  },
  {
    name: 'terminal_stop',
    description: 'Stop what is running in a tab (SIGINT), or close the tab entirely.',
    inputSchema: object(
      {
        sessionId: str('Session id from terminal_list'),
        close: bool('Close the tab as well (default false)'),
      },
      ['sessionId'],
    ),
    write: true,
    run: async ({ sessionId, close }) => {
      await call('terminal:signal', { sessionId, signal: 'SIGINT' });
      if (close) await call('terminal:close', { sessionId });
      return { sessionId, stopped: true, closed: Boolean(close) };
    },
  },
  {
    name: 'terminal_list_profiles',
    description: 'List the saved terminal profiles — named commands, some of which start with the app.',
    inputSchema: object({}),
    run: () => call('terminal:profiles'),
  },
  {
    name: 'terminal_save_profile',
    description:
      'Create or update a saved terminal profile. With autoStart, Erebus runs it in its own tab on every launch — the way to keep port-forwards always on.',
    inputSchema: object(
      {
        name: str('Profile name'),
        command: str('Command to run'),
        id: str('Existing profile id to update'),
        cwd: str('Working directory'),
        autoStart: bool('Run automatically when Erebus starts (default false)'),
      },
      ['name', 'command'],
    ),
    write: true,
    run: (args) =>
      call('terminal:saveProfile', {
        id: args.id ?? '',
        name: args.name,
        command: args.command,
        cwd: args.cwd,
        autoStart: args.autoStart ?? false,
      }),
  },
  {
    name: 'terminal_delete_profile',
    description: 'Delete a saved terminal profile.',
    inputSchema: object({ profileId: str('Profile id') }, ['profileId']),
    write: true,
    run: ({ profileId }) => call('terminal:deleteProfile', { profileId }),
  },

  /* ------------------------------------------------------------------ acls */
  {
    name: 'list_acls',
    description: 'List the ACLs defined on the cluster (requires an authorizer on the brokers).',
    inputSchema: object({ clusterId: CLUSTER }, ['clusterId']),
    run: ({ clusterId }) => call('acls:list', { clusterId }),
  },
];

export function visibleTools(): McpTool[] {
  const readonly = process.env.EREBUS_MCP_READONLY === '1' || process.env.EREBUS_MCP_READONLY === 'true';
  return readonly ? TOOLS.filter((t) => !t.write) : TOOLS;
}
