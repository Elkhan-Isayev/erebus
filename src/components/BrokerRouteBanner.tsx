import { useState } from 'react';
import type { BrokerRoute, ClusterConfig } from '@shared/types';
import { useAppState } from '@/app/AppState';
import { Icon } from '@/components/Icons';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

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

/**
 * Warns when brokers advertise addresses that lead to the wrong place from this machine.
 * Topic lists still work in that state — metadata comes from the bootstrap address — while
 * offsets and messages silently come from wherever the advertised address points.
 */
export function BrokerRouteBanner({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const { reloadClusters } = useAppState();
  const check = useAsync(() => api.brokerRoutes(cluster.id), [cluster.id, cluster.bootstrapServers, cluster.brokerOverrides, cluster.routeViaBootstrap]);
  const [fixing, setFixing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const bad = check.data?.routes.filter((r) => !r.ok) ?? [];
  if (dismissed || bad.length === 0) return null;
  const singleBroker = check.data?.routes.length === 1;

  const routeViaBootstrap = async () => {
    setFixing(true);
    try {
      await api.saveCluster({ ...cluster, routeViaBootstrap: true });
      await reloadClusters();
      toast.success(`Every broker connection now goes through ${check.data?.bootstrap}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="warn-banner">
      <Icon.Alert width={16} />
      <div style={{ flex: 1 }}>
        {describeMisroute(bad)}{' '}
        {singleBroker
          ? `If ${check.data?.bootstrap} is a port-forward to this broker, route every connection through it.`
          : 'Map each advertised address to a reachable one under Broker address overrides in the cluster settings.'}
      </div>
      {singleBroker && !cluster.routeViaBootstrap && (
        <Button size="sm" variant="primary" loading={fixing} onClick={() => void routeViaBootstrap()}>
          Route via {check.data?.bootstrap}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Dismiss
      </Button>
    </div>
  );
}
