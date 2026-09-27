/**
 * Which cluster is really behind a profile.
 *
 * A port number is not a cluster: behind kubectl port-forward the same localhost port
 * leads to dev one day and preprod the next, and a broker may advertise a port that
 * another tunnel owns. Kafka's Fetch and Produce requests carry no cluster id, so a
 * wrong target answers without complaint. Two checks catch it:
 *
 *   routes    every advertised broker address must answer as the bootstrap's cluster;
 *   identity  the bootstrap must answer as the cluster this profile was pinned to.
 *
 * The first catches a broker that points into another cluster. The second catches the
 * case the first cannot: every address consistently leading to the wrong cluster.
 *
 * Pure logic: the network probe is passed in, so both checks are unit-tested against
 * clusters that exist only in the test.
 */
import type { BrokerRoute, BrokerRouteCheck, ClusterConfig, ClusterIdentity } from '../../shared/types';
import { bootstrapList, routeAddress, splitAddress, type Address, type RoutingConfig } from './routing';

export interface ProbeResult {
  clusterId: string;
  brokers: { nodeId: number; host: string; port: number }[];
}

/** Asks whatever answers at `address`, and only there, which cluster it belongs to. */
export type Probe = (address: Address) => Promise<ProbeResult>;

type Profile = Pick<ClusterConfig, 'id' | 'name' | 'pinnedClusterId'>;

/** The saved profile, other than `self`, that is pinned to `clusterId`. */
export function profileFor(clusterId: string | null, profiles: Profile[], selfId: string): string | null {
  if (!clusterId) return null;
  return profiles.find((p) => p.id !== selfId && p.pinnedClusterId === clusterId)?.name ?? null;
}

export function judgeIdentity(pinned: string | undefined | null, actual: string, profiles: Profile[], selfId: string): ClusterIdentity {
  const actualProfile = profileFor(actual, profiles, selfId);
  if (pinned) return { status: pinned === actual ? 'match' : 'changed', expected: pinned, actual, actualProfile };
  // First sight. Pinning whatever answers is right unless another profile already owns
  // that cluster — then this tunnel most likely leads somewhere it should not, and the
  // person decides. Two profiles for one cluster (read-only and writable) is one click.
  return { status: actualProfile ? 'changed' : 'pinned-now', expected: null, actual, actualProfile };
}

/** Why writes to this profile must wait, or null when they may go ahead. */
export function writeBlockReason(profileName: string, identity: ClusterIdentity | null): string | null {
  if (identity?.status !== 'changed') return null;
  const now = identity.actualProfile ? `the cluster of "${identity.actualProfile}"` : `another cluster (${identity.actual})`;
  const was = identity.expected ? `not the cluster it was saved with (${identity.expected})` : 'which another profile already uses';
  return `"${profileName}" now reaches ${now}, ${was}. Writes are blocked until you confirm it.`;
}

function describeFailure(err: unknown): string {
  const { message, cause } = err as Error & { cause?: { code?: string } };
  const code = cause?.code;
  // Node reports a refused localhost dial as an AggregateError with no message of its own.
  return code ? `${message.replace(/:\s*$/, '')}: ${code}` : message;
}

export async function inspectCluster(
  config: RoutingConfig & Profile,
  profiles: Profile[],
  probe: Probe,
): Promise<BrokerRouteCheck> {
  const bootstrap = bootstrapList(config);
  const first = splitAddress(bootstrap[0]);
  // Both the reference id and the broker list come from the bootstrap address alone: a
  // pooled client would ask the misrouted broker, or fail outright when it is unreachable.
  const { clusterId, brokers } = await probe(routeAddress(config, first.host, first.port));

  const routes = await Promise.all(
    brokers.map(async (b): Promise<BrokerRoute> => {
      const target = routeAddress(config, b.host, b.port);
      const base = { nodeId: b.nodeId, advertised: `${b.host}:${b.port}`, connectsTo: `${target.host}:${target.port}` };
      try {
        const reached = (await probe(target)).clusterId;
        return { ...base, reachedClusterId: reached, reachedProfile: profileFor(reached, profiles, config.id), ok: reached === clusterId };
      } catch (err) {
        return { ...base, reachedClusterId: null, reachedProfile: null, ok: false, error: describeFailure(err) };
      }
    }),
  );

  return {
    clusterId,
    profileName: config.name,
    bootstrap: bootstrap.join(', '),
    routes: routes.sort((a, b) => a.nodeId - b.nodeId),
    identity: judgeIdentity(config.pinnedClusterId, clusterId, profiles, config.id),
  };
}
