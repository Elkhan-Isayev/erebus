import { useState } from 'react';
import type { BrokerRouteCheck, ClusterConfig } from '@shared/types';
import { useAppState } from '@/app/AppState';
import { Icon } from '@/components/Icons';
import { Button, ConfirmDialog } from '@/components/ui';
import { api } from '@/lib/api';
import { describeIdentityChange, describeMisroute } from '@/lib/brokerRoutes';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

/** Before → after, so a correction is never applied without seeing what it changes. */
function RouteChange({ check }: { check: BrokerRouteCheck }) {
  const [broker] = check.routes;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <b>Now</b> — broker {broker.nodeId} is dialled at <span className="mono">{broker.connectsTo}</span>, where{' '}
        {broker.reachedProfile ? `"${broker.reachedProfile}"` : (broker.reachedClusterId ?? 'nothing')} answers.
      </div>
      <div>
        <b>After</b> — every connection goes to <span className="mono">{check.bootstrap}</span>, where "{check.profileName}" (
        <span className="mono">{check.clusterId}</span>) answers.
      </div>
    </div>
  );
}

/**
 * Warns when this profile does not reach the cluster it should. Two ways that happens:
 * a broker advertises an address that leads into another cluster (topics come from one,
 * messages from the other), or the profile's own address now leads to a different
 * cluster than the one it was saved with — which only the pinned cluster id can reveal.
 */
export function BrokerRouteBanner({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const { reloadClusters } = useAppState();
  const check = useAsync(() => api.brokerRoutes(cluster.id), [cluster.id, cluster.bootstrapServers, cluster.brokerOverrides, cluster.routeViaBootstrap]);
  const [confirming, setConfirming] = useState<'route' | 'identity' | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const data = check.data;
  if (!data || dismissed) return null;
  const bad = data.routes.filter((r) => !r.ok);
  const changed = data.identity.status === 'changed';
  if (!changed && bad.length === 0) return null;
  const singleBroker = data.routes.length === 1;

  return (
    <>
      {changed && (
        <div className="error-banner">
          <Icon.Alert width={16} />
          <div style={{ flex: 1 }}>
            {describeIdentityChange(data.profileName, data.identity)} Produce, create, delete and config changes are blocked
            until you confirm this is the cluster you mean.
          </div>
          <Button size="sm" variant="ghost" onClick={() => setConfirming('identity')}>
            Review
          </Button>
        </div>
      )}

      {bad.length > 0 && (
        <div className="warn-banner">
          <Icon.Alert width={16} />
          <div style={{ flex: 1 }}>
            {describeMisroute(bad)}{' '}
            {singleBroker
              ? `If ${data.bootstrap} is a port-forward to this broker, route every connection through it.`
              : 'Map each advertised address to a reachable one under Broker address overrides in the cluster settings.'}
          </div>
          {singleBroker && !cluster.routeViaBootstrap && (
            <Button size="sm" variant="primary" onClick={() => setConfirming('route')}>
              Route via {data.bootstrap}…
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      )}

      {confirming === 'route' && (
        <ConfirmDialog
          title="Route every connection through the bootstrap address?"
          message={<RouteChange check={data} />}
          confirmLabel={`Route via ${data.bootstrap}`}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await api.saveCluster({ ...cluster, routeViaBootstrap: true });
              await reloadClusters();
              toast.success(`Every broker connection now goes through ${data.bootstrap}`);
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}

      {confirming === 'identity' && (
        <ConfirmDialog
          danger
          title={`Is this the cluster "${data.profileName}" should use?`}
          message={
            <div style={{ display: 'grid', gap: 10 }}>
              <div>{describeIdentityChange(data.profileName, data.identity)}</div>
              <div>
                Confirm only if you meant to point this profile there. Otherwise check which port-forward holds{' '}
                <span className="mono">{data.bootstrap}</span>.
              </div>
            </div>
          }
          confirmLabel="Use this cluster from now on"
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await api.confirmClusterIdentity(cluster.id, data.identity.actual);
              check.reload();
              toast.success(`"${data.profileName}" now expects cluster ${data.identity.actual}`);
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
