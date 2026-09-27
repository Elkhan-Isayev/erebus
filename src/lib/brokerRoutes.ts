import type { BrokerRoute, ClusterIdentity } from '@shared/types';

/** "the cluster of "Preprod"" when a saved profile owns the id, the bare id otherwise. */
const clusterLabel = (id: string, profile: string | null) => (profile ? `the cluster of "${profile}" (${id})` : `a different cluster (${id})`);

/** One sentence per broker whose advertised address leads somewhere else. */
export function describeMisroute(routes: BrokerRoute[]): string {
  return routes
    .map((r) => {
      const via = r.connectsTo === r.advertised ? r.advertised : `${r.advertised} (dialled as ${r.connectsTo})`;
      return r.reachedClusterId
        ? `Broker ${r.nodeId} advertises ${via}, but ${clusterLabel(r.reachedClusterId, r.reachedProfile)} answers there — reads and writes go to that cluster.`
        : `Broker ${r.nodeId} advertises ${via}, which is not reachable: ${r.error ?? 'no answer'}.`;
    })
    .join(' ');
}

/** What the profile expected against what answers now, in words a person can check. */
export function describeIdentityChange(profileName: string, identity: ClusterIdentity): string {
  const now = clusterLabel(identity.actual, identity.actualProfile);
  return identity.expected
    ? `"${profileName}" was saved with cluster ${identity.expected}, but ${now} answers at its address now.`
    : `"${profileName}" reaches ${now}, which another profile already uses.`;
}
