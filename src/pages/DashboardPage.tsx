import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Badge, Button, DataTable, ErrorBanner, KeyValue, Loading, PageHead, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { compactNumber, formatNumber } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';

export function DashboardPage({ cluster }: { cluster: ClusterConfig }) {
  const overview = useAsync(() => api.overview(cluster.id), [cluster.id]);

  if (overview.loading) return <Loading label="Talking to the cluster…" />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.reload} />;
  const data = overview.data!;

  return (
    <>
      <PageHead
        title={cluster.name}
        subtitle={
          <>
            <span className="mono">{cluster.bootstrapServers}</span> · cluster id{' '}
            <span className="mono">{data.clusterId || 'n/a'}</span>
          </>
        }
        actions={
          <Button onClick={overview.reload} loading={overview.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
        }
      />

      <div className="stat-grid">
        <Stat label="Brokers" value={data.brokers.length} sub={`controller ${data.controllerId}`} />
        <Stat
          label="Topics"
          value={formatNumber(data.topicCount)}
          sub={`${data.internalTopicCount} internal`}
        />
        <Stat label="Partitions" value={formatNumber(data.partitionCount)} sub={`${data.onlinePartitions} online`} />
        <Stat
          label="Under replicated"
          value={formatNumber(data.underReplicatedPartitions)}
          tone={data.underReplicatedPartitions > 0 ? 'warning' : undefined}
          sub={data.underReplicatedPartitions > 0 ? 'needs attention' : 'all in sync'}
        />
        <Stat
          label="Offline partitions"
          value={formatNumber(data.offlinePartitions)}
          tone={data.offlinePartitions > 0 ? 'danger' : undefined}
          sub={data.offlinePartitions > 0 ? 'no leader elected' : 'healthy'}
        />
        <Stat label="Consumer groups" value={formatNumber(data.consumerGroupCount)} />
        <Stat label="Messages" value={compactNumber(data.totalMessages)} sub="across non-internal topics" />
      </div>

      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>Brokers</h3>
            <div className="actions">
              <Button size="sm" variant="ghost" onClick={() => navigate(`/c/${cluster.id}/brokers`)}>
                View all
              </Button>
            </div>
          </div>
          <DataTable
            rows={data.brokers}
            rowKey={(b) => String(b.nodeId)}
            onRowClick={(b) => navigate(`/c/${cluster.id}/brokers?node=${b.nodeId}`)}
            columns={[
              {
                key: 'id',
                header: 'ID',
                render: (b) => (
                  <>
                    <span className="mono">{b.nodeId}</span>{' '}
                    {b.isController && <Badge tone="accent">controller</Badge>}
                  </>
                ),
              },
              { key: 'host', header: 'Host', render: (b) => <span className="mono">{`${b.host}:${b.port}`}</span> },
              { key: 'rack', header: 'Rack', render: (b) => b.rack ?? <span className="subtle">—</span> },
            ]}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Integrations</h3>
          </div>
          <div className="card-pad">
            <KeyValue
              items={[
                [
                  'Schema Registry',
                  data.features.schemaRegistry ? (
                    <a href={`#/c/${cluster.id}/schemas`}>{cluster.schemaRegistry?.url}</a>
                  ) : (
                    <span className="subtle">not configured</span>
                  ),
                ],
                [
                  'Kafka Connect',
                  data.features.kafkaConnect ? (
                    <a href={`#/c/${cluster.id}/connect`}>{cluster.connects.map((c) => c.name).join(', ')}</a>
                  ) : (
                    <span className="subtle">not configured</span>
                  ),
                ],
                [
                  'ksqlDB',
                  data.features.ksqldb ? (
                    <a href={`#/c/${cluster.id}/ksql`}>{cluster.ksqldb?.url}</a>
                  ) : (
                    <span className="subtle">not configured</span>
                  ),
                ],
                ['Security', cluster.sasl ? `SASL ${cluster.sasl.mechanism}` : 'PLAINTEXT'],
                ['TLS', cluster.ssl?.enabled ? (cluster.ssl.rejectUnauthorized ? 'verified' : 'insecure') : 'off'],
                ['Mode', cluster.readonly ? <Badge tone="warning">read-only</Badge> : 'read / write'],
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}
