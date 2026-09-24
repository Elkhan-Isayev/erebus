import type { BrokerRoute } from '@shared/types';

/** One sentence per broker whose advertised address leads somewhere else. */
export function describeMisroute(routes: BrokerRoute[]): string {
  return routes
    .map((r) => {
      const via = r.connectsTo === r.advertised ? r.advertised : `${r.advertised} (dialled as ${r.connectsTo})`;
      return r.reachedClusterId
        ? `Broker ${r.nodeId} advertises ${via}, but a different cluster (${r.reachedClusterId}) answers there — reads and writes go to that cluster.`
        : `Broker ${r.nodeId} advertises ${via}, which is not reachable: ${r.error ?? 'no answer'}.`;
    })
    .join(' ');
}
