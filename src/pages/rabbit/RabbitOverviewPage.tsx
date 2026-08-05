import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Badge, Button, DataTable, ErrorBanner, KeyValue, Loading, PageHead, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { compactNumber, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';

export function RabbitOverviewPage({ cluster }: { cluster: ClusterConfig }) {
  const overview = useAsync(() => api.rabbitOverview(cluster.id), [cluster.id]);

  if (overview.loading) return <Loading label="Talking to the management API…" />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.reload} />;
  const data = overview.data!;

  return (
    <>
      <PageHead
        title={cluster.name}
        subtitle={
          <>
            <span className="mono">{cluster.rabbit?.url}</span> · vhost{' '}
            <span className="mono">{cluster.rabbit?.vhost}</span> · RabbitMQ {data.version}
          </>
        }
        actions={
          <Button onClick={overview.reload} loading={overview.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
        }
      />

      <div className="stat-grid">
        <Stat label="Ready" value={compactNumber(data.queueTotals.ready)} sub="messages waiting" />
        <Stat
          label="Unacknowledged"
          value={compactNumber(data.queueTotals.unacknowledged)}
          tone={data.queueTotals.unacknowledged > 0 ? 'warning' : undefined}
          sub="delivered, not acked"
        />
        <Stat label="Queues" value={formatNumber(data.objectTotals.queues)} />
        <Stat label="Exchanges" value={formatNumber(data.objectTotals.exchanges)} />
        <Stat label="Connections" value={formatNumber(data.objectTotals.connections)} sub={`${data.objectTotals.channels} channels`} />
        <Stat label="Consumers" value={formatNumber(data.objectTotals.consumers)} />
        <Stat
          label="Publish rate"
          value={`${data.messageRates.publish.toFixed(1)}/s`}
          sub={`deliver ${data.messageRates.deliver.toFixed(1)}/s`}
        />
      </div>

      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>Nodes</h3>
            <div className="actions">
              <Button size="sm" variant="ghost" onClick={() => navigate(`/c/${cluster.id}/queues`)}>
                Queues
              </Button>
            </div>
          </div>
          <DataTable
            rows={data.nodes}
            rowKey={(n) => n.name}
            columns={[
              {
                key: 'name',
                header: 'Node',
                render: (n) => (
                  <>
                    <span className="mono">{n.name}</span>{' '}
                    <Badge tone={n.running ? 'success' : 'danger'}>{n.running ? 'running' : 'down'}</Badge>
                  </>
                ),
              },
              {
                key: 'mem',
                header: 'Memory',
                align: 'right',
                render: (n) => (
                  <span className="num">
                    {formatBytes(n.memUsed)}
                    {n.memLimit > 0 && <span className="subtle"> / {formatBytes(n.memLimit)}</span>}
                  </span>
                ),
              },
              { key: 'disk', header: 'Disk free', align: 'right', render: (n) => <span className="num">{formatBytes(n.diskFree)}</span> },
              { key: 'uptime', header: 'Uptime', align: 'right', render: (n) => <span className="num">{formatDuration(n.uptime)}</span> },
            ]}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Broker</h3>
          </div>
          <div className="card-pad">
            <KeyValue
              items={[
                ['Cluster name', <span className="mono">{data.clusterName}</span>],
                ['RabbitMQ', data.version],
                ['Erlang', data.erlangVersion || '—'],
                ['Virtual hosts', <span className="chip-list">{data.vhosts.map((v) => <Badge key={v}>{v}</Badge>)}</span>],
                [
                  'Listeners',
                  <span className="chip-list">
                    {data.listeners.map((l, i) => (
                      <Badge key={i} tone="info">
                        {l.protocol}:{l.port}
                      </Badge>
                    ))}
                  </span>,
                ],
                ['Mode', cluster.readonly ? <Badge tone="warning">read-only</Badge> : 'read / write'],
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}
