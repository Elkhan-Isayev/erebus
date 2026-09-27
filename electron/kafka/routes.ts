/**
 * The network side of identity.ts: probes real addresses, pins a profile to the cluster
 * it reaches, and keeps writes away from a cluster the profile was not saved with.
 */
import type { BrokerRoute, BrokerRouteCheck, ClusterConfig } from '../../shared/types';
import * as store from '../store';
import { inspectCluster, writeBlockReason, type ProbeResult } from './identity';
import { assertNotReadonly, buildKafka, clusterFor } from './pool';
import type { Address } from './routing';

const PROBE_TIMEOUT_MS = 5_000;
/** A write reuses a check this recent; tunnels do not change hands that often. */
const WRITE_CHECK_TTL_MS = 30_000;

const recent = new Map<string, { at: number; check: BrokerRouteCheck }>();

/** The cluster that answers at `address` — and only there. */
async function describeAt(config: ClusterConfig, address: Address): Promise<ProbeResult> {
  const timeout = Math.min(config.connectionTimeoutMs, PROBE_TIMEOUT_MS);
  // Pinned, because kafkajs refreshes metadata from any broker it already knows, which is
  // exactly the misrouted one we are trying to catch.
  const probe = buildKafka(
    { ...config, connectionTimeoutMs: timeout, requestTimeoutMs: timeout },
    { retry: { retries: 0 }, pinTo: address },
  ).admin();
  try {
    await probe.connect();
    return await probe.describeCluster();
  } finally {
    void probe.disconnect().catch(() => {});
  }
}

export async function checkBrokerRoutes(clusterId: string): Promise<BrokerRouteCheck> {
  const config = clusterFor(clusterId);
  const check = await inspectCluster(config, store.listClusters(), (address) => describeAt(config, address));
  if (check.identity.status === 'pinned-now') store.setPinnedClusterId(clusterId, check.identity.actual);
  recent.set(clusterId, { at: Date.now(), check });
  return check;
}

/** The person looked at what answers now and says it is right: pin the profile to it. */
export async function confirmIdentity(clusterId: string, actual: string): Promise<BrokerRouteCheck> {
  // Pin exactly what was shown, never whatever answers by the time the click lands.
  const fresh = await checkBrokerRoutes(clusterId);
  if (fresh.clusterId !== actual) throw new Error('A different cluster answers now than the one you confirmed — check again');
  store.setPinnedClusterId(clusterId, actual);
  return checkBrokerRoutes(clusterId);
}

export function forgetIdentity(clusterId: string): void {
  recent.delete(clusterId);
}

/** Read-only first, then: is this still the cluster the profile was saved with? */
export async function assertWritable(clusterId: string): Promise<void> {
  assertNotReadonly(clusterId);
  const cached = recent.get(clusterId);
  const check = cached && Date.now() - cached.at < WRITE_CHECK_TTL_MS ? cached.check : await checkBrokerRoutes(clusterId);
  const reason = writeBlockReason(check.profileName, check.identity);
  if (reason) throw new Error(reason);
}

export async function testConnection(
  clusterId: string,
): Promise<{ brokers: number; clusterId: string; misrouted: BrokerRoute[]; identityWarning: string | null }> {
  const check = await checkBrokerRoutes(clusterId);
  return {
    brokers: check.routes.length,
    clusterId: check.clusterId,
    misrouted: check.routes.filter((r) => !r.ok),
    identityWarning: writeBlockReason(check.profileName, check.identity),
  };
}
