import { useMemo, useState } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Badge, Button, DataTable, ErrorBanner, Loading, Modal, PageHead, SearchInput } from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';

function BrokerConfigs({ clusterId, nodeId, onClose }: { clusterId: string; nodeId: number; onClose: () => void }) {
  const configs = useAsync(() => api.brokerConfigs(clusterId, nodeId), [clusterId, nodeId]);
  const [search, setSearch] = useState('');

  const rows = useMemo(
    () => (configs.data ?? []).filter((c) => c.name.toLowerCase().includes(search.toLowerCase())),
    [configs.data, search],
  );

  return (
    <Modal wide title={`Broker ${nodeId} configuration`} onClose={onClose}>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter configuration keys…" autoFocus />
      </div>
      {configs.loading && <Loading />}
      {configs.error && <ErrorBanner error={configs.error} onRetry={configs.reload} />}
      {configs.data && (
        <DataTable
          rows={rows}
          rowKey={(c) => c.name}
          columns={[
            { key: 'name', header: 'Key', render: (c) => <span className="mono">{c.name}</span> },
            {
              key: 'value',
              header: 'Value',
              render: (c) =>
                c.isSensitive ? (
                  <span className="subtle">•••••</span>
                ) : (
                  <span className="mono" style={{ wordBreak: 'break-all' }}>
                    {c.value || '—'}
                  </span>
                ),
            },
            {
              key: 'source',
              header: 'Source',
              render: (c) => (c.isDefault ? <Badge>default</Badge> : <Badge tone="accent">overridden</Badge>),
            },
          ]}
        />
      )}
    </Modal>
  );
}

export function BrokersPage({ cluster, initialNode }: { cluster: ClusterConfig; initialNode?: number }) {
  const brokers = useAsync(() => api.brokers(cluster.id), [cluster.id]);
  const [selected, setSelected] = useState<number | null>(initialNode ?? null);

  return (
    <>
      <PageHead
        title="Brokers"
        subtitle="Nodes serving this cluster. Open a broker to inspect its effective configuration."
        actions={
          <Button onClick={brokers.reload} loading={brokers.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
        }
      />

      {brokers.loading && <Loading />}
      {brokers.error && <ErrorBanner error={brokers.error} onRetry={brokers.reload} />}
      {brokers.data && (
        <DataTable
          rows={brokers.data}
          rowKey={(b) => String(b.nodeId)}
          onRowClick={(b) => setSelected(b.nodeId)}
          columns={[
            {
              key: 'nodeId',
              header: 'Node',
              render: (b) => (
                <>
                  <span className="mono link-cell">{b.nodeId}</span>{' '}
                  {b.isController && <Badge tone="accent">controller</Badge>}
                </>
              ),
            },
            { key: 'host', header: 'Host', render: (b) => <span className="mono">{b.host}</span> },
            { key: 'port', header: 'Port', render: (b) => <span className="mono">{b.port}</span> },
            { key: 'rack', header: 'Rack', render: (b) => b.rack ?? <span className="subtle">—</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (b) => (
                <div className="row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(b.nodeId)}>
                    Configuration
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {selected !== null && (
        <BrokerConfigs clusterId={cluster.id} nodeId={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
