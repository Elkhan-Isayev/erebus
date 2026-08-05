/**
 * RabbitMQ support goes through the management plugin's HTTP API — the same surface
 * the built-in management UI uses, so no AMQP client is needed.
 */
import type {
  RabbitBinding,
  RabbitChannel,
  RabbitConnection,
  RabbitConsumerInfo,
  RabbitExchange,
  RabbitMessage,
  RabbitOverview,
  RabbitPublishInput,
  RabbitQueue,
} from '../../shared/types';
import { getCluster } from '../store';
import { restRequest, type RestTarget } from '../rest/http';

function target(clusterId: string): RestTarget & { vhost: string } {
  const cluster = getCluster(clusterId);
  if (cluster.kind !== 'rabbitmq' || !cluster.rabbit?.url) {
    throw new Error(`Cluster ${cluster.name} is not a RabbitMQ connection`);
  }
  return {
    url: cluster.rabbit.url,
    username: cluster.rabbit.username,
    password: cluster.rabbit.password,
    vhost: cluster.rabbit.vhost || '/',
  };
}

function assertWritable(clusterId: string): void {
  if (getCluster(clusterId).readonly) throw new Error('Cluster is marked read-only — enable writes in cluster settings');
}

const enc = (value: string) => encodeURIComponent(value);

// RabbitMQ answers 406 to a bare `Accept: application/json` on its no-content endpoints.
const ACCEPT = 'application/json, */*';

const call = <T>(clusterId: string, path: string, init?: Parameters<typeof restRequest>[2]) =>
  restRequest<T>(target(clusterId), `/api${path}`, { accept: ACCEPT, ...init });

export const vhostOf = (clusterId: string) => target(clusterId).vhost;

const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const rate = (details: any) => num(details?.rate);

/* -------------------------------------------------------------- overview */

export async function overview(clusterId: string): Promise<RabbitOverview> {
  const [raw, nodes, vhosts] = await Promise.all([
    call<any>(clusterId, '/overview'),
    call<any[]>(clusterId, '/nodes').catch(() => []),
    call<any[]>(clusterId, '/vhosts').catch(() => []),
  ]);

  return {
    clusterName: raw.cluster_name ?? 'rabbit',
    version: raw.rabbitmq_version ?? raw.product_version ?? 'unknown',
    erlangVersion: raw.erlang_version ?? '',
    nodes: (nodes ?? []).map((n) => ({
      name: n.name,
      running: Boolean(n.running),
      memUsed: num(n.mem_used),
      memLimit: num(n.mem_limit),
      diskFree: num(n.disk_free),
      uptime: num(n.uptime),
      type: n.type ?? 'disc',
    })),
    queueTotals: {
      messages: num(raw.queue_totals?.messages),
      ready: num(raw.queue_totals?.messages_ready),
      unacknowledged: num(raw.queue_totals?.messages_unacknowledged),
    },
    objectTotals: {
      queues: num(raw.object_totals?.queues),
      exchanges: num(raw.object_totals?.exchanges),
      connections: num(raw.object_totals?.connections),
      channels: num(raw.object_totals?.channels),
      consumers: num(raw.object_totals?.consumers),
    },
    messageRates: {
      publish: rate(raw.message_stats?.publish_details),
      deliver: rate(raw.message_stats?.deliver_get_details),
      ack: rate(raw.message_stats?.ack_details),
      redeliver: rate(raw.message_stats?.redeliver_details),
    },
    listeners: (raw.listeners ?? []).map((l: any) => ({ protocol: l.protocol, port: l.port, node: l.node })),
    vhosts: (vhosts ?? []).map((v) => v.name),
  };
}

export const testConnection = async (clusterId: string) => {
  const raw = await call<any>(clusterId, '/overview');
  return { version: raw.rabbitmq_version ?? raw.product_version, cluster: raw.cluster_name, node: raw.node };
};

/* ---------------------------------------------------------------- queues */

const toQueue = (q: any): RabbitQueue => ({
  name: q.name,
  vhost: q.vhost,
  state: q.state ?? 'unknown',
  type: q.type ?? 'classic',
  durable: Boolean(q.durable),
  autoDelete: Boolean(q.auto_delete),
  exclusive: Boolean(q.exclusive),
  node: q.node ?? '',
  messages: num(q.messages),
  ready: num(q.messages_ready),
  unacknowledged: num(q.messages_unacknowledged),
  consumers: num(q.consumers),
  memory: num(q.memory),
  publishRate: rate(q.message_stats?.publish_details),
  deliverRate: rate(q.message_stats?.deliver_get_details),
  arguments: q.arguments ?? {},
  policy: q.policy ?? null,
});

export async function listQueues(clusterId: string): Promise<RabbitQueue[]> {
  const queues = await call<any[]>(clusterId, `/queues/${enc(vhostOf(clusterId))}`);
  return queues.map(toQueue).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getQueue(clusterId: string, name: string): Promise<RabbitQueue & { bindings: RabbitBinding[] }> {
  const vhost = vhostOf(clusterId);
  const [queue, bindings] = await Promise.all([
    call<any>(clusterId, `/queues/${enc(vhost)}/${enc(name)}`),
    call<any[]>(clusterId, `/queues/${enc(vhost)}/${enc(name)}/bindings`).catch(() => []),
  ]);
  return { ...toQueue(queue), bindings: (bindings ?? []).map(toBinding) };
}

export async function createQueue(
  clusterId: string,
  name: string,
  options: { durable?: boolean; autoDelete?: boolean; arguments?: Record<string, unknown> } = {},
): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/queues/${enc(vhostOf(clusterId))}/${enc(name)}`, {
    method: 'PUT',
    body: {
      durable: options.durable ?? true,
      auto_delete: options.autoDelete ?? false,
      arguments: options.arguments ?? {},
    },
  });
}

export async function deleteQueue(clusterId: string, name: string): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/queues/${enc(vhostOf(clusterId))}/${enc(name)}`, { method: 'DELETE' });
}

export async function purgeQueue(clusterId: string, name: string): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/queues/${enc(vhostOf(clusterId))}/${enc(name)}/contents`, { method: 'DELETE' });
}

/* -------------------------------------------------------------- messages */

export async function getMessages(
  clusterId: string,
  queue: string,
  options: { count?: number; requeue?: boolean; encoding?: 'auto' | 'base64' } = {},
): Promise<RabbitMessage[]> {
  // Reading is a write in AMQP terms: it takes messages off the queue unless requeued.
  const requeue = options.requeue ?? true;
  if (!requeue) assertWritable(clusterId);

  const raw = await call<any[]>(clusterId, `/queues/${enc(vhostOf(clusterId))}/${enc(queue)}/get`, {
    method: 'POST',
    body: {
      count: options.count ?? 20,
      ackmode: requeue ? 'ack_requeue_true' : 'ack_requeue_false',
      encoding: options.encoding ?? 'auto',
      truncate: 100_000,
    },
  });

  return (raw ?? []).map((m) => ({
    payload: m.payload ?? '',
    payloadBytes: num(m.payload_bytes),
    payloadEncoding: m.payload_encoding ?? 'string',
    routingKey: m.routing_key ?? '',
    exchange: m.exchange ?? '',
    redelivered: Boolean(m.redelivered),
    messageCount: num(m.message_count),
    properties: m.properties ?? {},
    headers: m.properties?.headers ?? {},
  }));
}

export async function publish(input: RabbitPublishInput): Promise<{ routed: boolean }> {
  assertWritable(input.clusterId);
  const properties: Record<string, unknown> = { delivery_mode: 2, ...(input.properties ?? {}) };
  if (input.headers && Object.keys(input.headers).length > 0) properties.headers = input.headers;

  const result = await call<{ routed: boolean }>(
    input.clusterId,
    // The default exchange is addressed by its real name in the HTTP API.
    `/exchanges/${enc(vhostOf(input.clusterId))}/${enc(input.exchange || 'amq.default')}/publish`,
    {
      method: 'POST',
      body: {
        properties,
        routing_key: input.routingKey,
        payload: input.payload,
        payload_encoding: input.payloadEncoding ?? 'string',
      },
    },
  );
  return { routed: Boolean(result?.routed) };
}

/* ------------------------------------------------------------- exchanges */

const toExchange = (e: any): RabbitExchange => ({
  name: e.name,
  vhost: e.vhost,
  type: e.type,
  durable: Boolean(e.durable),
  autoDelete: Boolean(e.auto_delete),
  internal: Boolean(e.internal),
  arguments: e.arguments ?? {},
  publishInRate: rate(e.message_stats?.publish_in_details),
  publishOutRate: rate(e.message_stats?.publish_out_details),
});

export async function listExchanges(clusterId: string): Promise<RabbitExchange[]> {
  const exchanges = await call<any[]>(clusterId, `/exchanges/${enc(vhostOf(clusterId))}`);
  return exchanges.map(toExchange).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExchange(
  clusterId: string,
  name: string,
): Promise<RabbitExchange & { bindings: RabbitBinding[] }> {
  const vhost = vhostOf(clusterId);
  const [exchange, bindings] = await Promise.all([
    call<any>(clusterId, `/exchanges/${enc(vhost)}/${enc(name)}`),
    call<any[]>(clusterId, `/exchanges/${enc(vhost)}/${enc(name)}/bindings/source`).catch(() => []),
  ]);
  return { ...toExchange(exchange), bindings: (bindings ?? []).map(toBinding) };
}

export async function createExchange(
  clusterId: string,
  name: string,
  options: { type?: string; durable?: boolean; autoDelete?: boolean; internal?: boolean; arguments?: Record<string, unknown> } = {},
): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/exchanges/${enc(vhostOf(clusterId))}/${enc(name)}`, {
    method: 'PUT',
    body: {
      type: options.type ?? 'direct',
      durable: options.durable ?? true,
      auto_delete: options.autoDelete ?? false,
      internal: options.internal ?? false,
      arguments: options.arguments ?? {},
    },
  });
}

export async function deleteExchange(clusterId: string, name: string): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/exchanges/${enc(vhostOf(clusterId))}/${enc(name)}`, { method: 'DELETE' });
}

/* -------------------------------------------------------------- bindings */

const toBinding = (b: any): RabbitBinding => ({
  source: b.source,
  destination: b.destination,
  destinationType: b.destination_type,
  routingKey: b.routing_key ?? '',
  vhost: b.vhost,
  arguments: b.arguments ?? {},
  propertiesKey: b.properties_key ?? '~',
});

export async function listBindings(clusterId: string): Promise<RabbitBinding[]> {
  const bindings = await call<any[]>(clusterId, `/bindings/${enc(vhostOf(clusterId))}`);
  return (bindings ?? []).map(toBinding);
}

export async function createBinding(
  clusterId: string,
  source: string,
  destination: string,
  options: { destinationType?: 'queue' | 'exchange'; routingKey?: string; arguments?: Record<string, unknown> } = {},
): Promise<void> {
  assertWritable(clusterId);
  const kind = options.destinationType === 'exchange' ? 'e' : 'q';
  await call(clusterId, `/bindings/${enc(vhostOf(clusterId))}/e/${enc(source)}/${kind}/${enc(destination)}`, {
    method: 'POST',
    body: { routing_key: options.routingKey ?? '', arguments: options.arguments ?? {} },
  });
}

export async function deleteBinding(clusterId: string, binding: RabbitBinding): Promise<void> {
  assertWritable(clusterId);
  const kind = binding.destinationType === 'exchange' ? 'e' : 'q';
  await call(
    clusterId,
    `/bindings/${enc(vhostOf(clusterId))}/e/${enc(binding.source)}/${kind}/${enc(binding.destination)}/${enc(
      binding.propertiesKey,
    )}`,
    { method: 'DELETE' },
  );
}

/* ------------------------------------------------- connections / channels */

export async function listConnections(clusterId: string): Promise<RabbitConnection[]> {
  const connections = await call<any[]>(clusterId, '/connections');
  return (connections ?? []).map((c) => ({
    name: c.name,
    user: c.user ?? '',
    vhost: c.vhost ?? '',
    state: c.state ?? 'unknown',
    protocol: c.protocol ?? '',
    peerHost: c.peer_host ?? '',
    peerPort: num(c.peer_port),
    channels: num(c.channels),
    ssl: Boolean(c.ssl),
    connectedAt: num(c.connected_at),
    clientProperties: c.client_properties ?? {},
  }));
}

export async function closeConnection(clusterId: string, name: string): Promise<void> {
  assertWritable(clusterId);
  await call(clusterId, `/connections/${enc(name)}`, { method: 'DELETE' });
}

export async function listChannels(clusterId: string): Promise<RabbitChannel[]> {
  const channels = await call<any[]>(clusterId, '/channels');
  return (channels ?? []).map((c) => ({
    name: c.name,
    connection: c.connection_details?.name ?? '',
    user: c.user ?? '',
    vhost: c.vhost ?? '',
    state: c.state ?? 'unknown',
    consumerCount: num(c.consumer_count),
    unacknowledged: num(c.messages_unacknowledged),
    prefetchCount: num(c.prefetch_count),
    transactional: Boolean(c.transactional),
    confirm: Boolean(c.confirm),
  }));
}

export async function listConsumers(clusterId: string): Promise<RabbitConsumerInfo[]> {
  const consumers = await call<any[]>(clusterId, `/consumers/${enc(vhostOf(clusterId))}`).catch(() =>
    call<any[]>(clusterId, '/consumers'),
  );
  return (consumers ?? []).map((c) => ({
    queue: c.queue?.name ?? '',
    vhost: c.queue?.vhost ?? '',
    channel: c.channel_details?.name ?? '',
    consumerTag: c.consumer_tag ?? '',
    ackRequired: Boolean(c.ack_required),
    prefetchCount: num(c.prefetch_count),
    exclusive: Boolean(c.exclusive),
  }));
}

export const listVhosts = (clusterId: string) => call<any[]>(clusterId, '/vhosts').then((v) => v.map((x) => x.name));
