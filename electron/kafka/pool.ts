import { Kafka, logLevel, type Admin, type Consumer, type Producer, type SASLOptions } from 'kafkajs';
import type { ClusterConfig } from '../../shared/types';
import { getCluster } from '../store';
// Registers Snappy, LZ4 and ZSTD before any client is built.
import './codecs';

interface Pooled {
  cluster: ClusterConfig;
  kafka: Kafka;
  admin?: Admin;
  adminReady?: Promise<Admin>;
  producer?: Producer;
  producerReady?: Promise<Producer>;
  /** Serialised signature of the config — a change invalidates the pool entry. */
  signature: string;
}

const pool = new Map<string, Pooled>();

function signatureOf(c: ClusterConfig): string {
  return JSON.stringify([c.bootstrapServers, c.clientId, c.ssl, c.sasl, c.requestTimeoutMs, c.connectionTimeoutMs]);
}

export function buildKafka(cluster: ClusterConfig): Kafka {
  const brokers = cluster.bootstrapServers
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new Error('No bootstrap servers configured');

  const sasl: SASLOptions | undefined = cluster.sasl
    ? ({
        mechanism: cluster.sasl.mechanism,
        username: cluster.sasl.username,
        password: cluster.sasl.password,
      } as SASLOptions)
    : undefined;

  const ssl = cluster.ssl?.enabled
    ? {
        rejectUnauthorized: cluster.ssl.rejectUnauthorized,
        ca: cluster.ssl.ca ? [cluster.ssl.ca] : undefined,
        cert: cluster.ssl.cert || undefined,
        key: cluster.ssl.key || undefined,
        passphrase: cluster.ssl.passphrase || undefined,
      }
    : undefined;

  return new Kafka({
    clientId: cluster.clientId || 'erebus',
    brokers,
    ssl,
    sasl,
    connectionTimeout: cluster.connectionTimeoutMs,
    requestTimeout: cluster.requestTimeoutMs,
    enforceRequestTimeout: true,
    logLevel: logLevel.ERROR,
    retry: { retries: 5, initialRetryTime: 250, maxRetryTime: 4_000 },
  });
}

function entry(clusterId: string): Pooled {
  const cluster = getCluster(clusterId);
  const sig = signatureOf(cluster);
  const existing = pool.get(clusterId);
  if (existing && existing.signature === sig) {
    existing.cluster = cluster;
    return existing;
  }
  if (existing) void disconnect(clusterId);
  const fresh: Pooled = { cluster, kafka: buildKafka(cluster), signature: sig };
  pool.set(clusterId, fresh);
  return fresh;
}

export function kafkaFor(clusterId: string): Kafka {
  return entry(clusterId).kafka;
}

export function clusterFor(clusterId: string): ClusterConfig {
  return entry(clusterId).cluster;
}

export async function adminFor(clusterId: string): Promise<Admin> {
  const e = entry(clusterId);
  if (e.admin) return e.admin;
  if (!e.adminReady) {
    const admin = e.kafka.admin();
    e.adminReady = admin
      .connect()
      .then(() => {
        e.admin = admin;
        return admin;
      })
      .catch((err) => {
        e.adminReady = undefined;
        throw err;
      });
  }
  return e.adminReady;
}

export async function producerFor(clusterId: string): Promise<Producer> {
  const e = entry(clusterId);
  if (e.cluster.readonly) throw new Error('Cluster is marked read-only');
  if (e.producer) return e.producer;
  if (!e.producerReady) {
    const producer = e.kafka.producer({ allowAutoTopicCreation: false, idempotent: false });
    e.producerReady = producer
      .connect()
      .then(() => {
        e.producer = producer;
        return producer;
      })
      .catch((err) => {
        e.producerReady = undefined;
        throw err;
      });
  }
  return e.producerReady;
}

/** Short-lived consumer used for browsing; the transient group is deleted afterwards. */
export function scratchConsumer(clusterId: string, groupId: string): Consumer {
  return entry(clusterId).kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    maxWaitTimeInMs: 500,
    maxBytesPerPartition: 2 * 1024 * 1024,
    retry: { retries: 1 },
    readUncommitted: false,
  });
}

export function assertWritable(clusterId: string): void {
  if (clusterFor(clusterId).readonly) throw new Error('Cluster is marked read-only — enable writes in cluster settings');
}

export async function disconnect(clusterId: string): Promise<void> {
  const e = pool.get(clusterId);
  if (!e) return;
  pool.delete(clusterId);
  await Promise.allSettled([e.admin?.disconnect(), e.producer?.disconnect()]);
}

export async function disconnectAll(): Promise<void> {
  await Promise.allSettled([...pool.keys()].map(disconnect));
}
