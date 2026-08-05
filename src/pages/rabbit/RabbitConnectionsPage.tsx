import { useState } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Badge, Button, ConfirmDialog, DataTable, EmptyState, ErrorBanner, Loading, PageHead, StateBadge, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

type TabId = 'connections' | 'channels' | 'consumers';

export function RabbitConnectionsPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('connections');
  const connections = useAsync(() => api.rabbitConnections(cluster.id), [cluster.id]);
  const channels = useAsync(() => api.rabbitChannels(cluster.id), [cluster.id], { enabled: tab === 'channels' });
  const consumers = useAsync(() => api.rabbitConsumers(cluster.id), [cluster.id], { enabled: tab === 'consumers' });
  const [closing, setClosing] = useState<string | null>(null);

  const active = tab === 'connections' ? connections : tab === 'channels' ? channels : consumers;

  return (
    <>
      <PageHead
        title="Connections"
        subtitle="Live clients attached to the broker, their channels and consumers."
        actions={
          <Button onClick={active.reload} loading={active.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'connections', label: 'Connections', badge: connections.data?.length },
          { id: 'channels', label: 'Channels' },
          { id: 'consumers', label: 'Consumers' },
        ]}
      />

      {active.loading && <Loading />}
      {active.error && <ErrorBanner error={active.error} onRetry={active.reload} />}

      {tab === 'connections' && connections.data && (
        <DataTable
          rows={connections.data}
          rowKey={(c) => c.name}
          empty={<EmptyState icon={<Icon.Plug />} title="No client is connected" />}
          columns={[
            { key: 'peer', header: 'Client', render: (c) => <span className="mono">{`${c.peerHost}:${c.peerPort}`}</span> },
            { key: 'user', header: 'User', render: (c) => <span className="mono">{c.user}</span> },
            { key: 'vhost', header: 'Vhost', render: (c) => <Badge>{c.vhost}</Badge> },
            { key: 'state', header: 'State', render: (c) => <StateBadge state={c.state} /> },
            { key: 'protocol', header: 'Protocol', render: (c) => <span className="subtle">{c.protocol}</span> },
            { key: 'channels', header: 'Channels', align: 'right', render: (c) => c.channels },
            { key: 'tls', header: 'TLS', render: (c) => (c.ssl ? <Badge tone="success">yes</Badge> : <Badge>no</Badge>) },
            { key: 'since', header: 'Connected', render: (c) => <span className="subtle mono">{formatTimestamp(c.connectedAt)}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (c) => (
                <div className="row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Close connection"
                    disabled={cluster.readonly}
                    onClick={() => setClosing(c.name)}
                  >
                    <Icon.X width={14} />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {tab === 'channels' && channels.data && (
        <DataTable
          rows={channels.data}
          rowKey={(c) => c.name}
          empty={<EmptyState icon={<Icon.Plug />} title="No open channels" />}
          columns={[
            { key: 'name', header: 'Channel', render: (c) => <span className="mono">{c.name}</span> },
            { key: 'user', header: 'User', render: (c) => <span className="mono">{c.user}</span> },
            { key: 'state', header: 'State', render: (c) => <StateBadge state={c.state} /> },
            { key: 'consumers', header: 'Consumers', align: 'right', render: (c) => c.consumerCount },
            {
              key: 'unacked',
              header: 'Unacked',
              align: 'right',
              render: (c) => (
                <span className="num" style={c.unacknowledged > 0 ? { color: 'var(--warning)' } : undefined}>
                  {c.unacknowledged}
                </span>
              ),
            },
            { key: 'prefetch', header: 'Prefetch', align: 'right', render: (c) => c.prefetchCount || '—' },
            {
              key: 'mode',
              header: 'Mode',
              render: (c) => (
                <div className="chip-list">
                  {c.confirm && <Badge tone="info">confirm</Badge>}
                  {c.transactional && <Badge tone="info">tx</Badge>}
                </div>
              ),
            },
          ]}
        />
      )}

      {tab === 'consumers' && consumers.data && (
        <DataTable
          rows={consumers.data}
          rowKey={(c) => `${c.channel}/${c.consumerTag}`}
          empty={<EmptyState icon={<Icon.Groups />} title="No consumers" description="Nothing is subscribed to a queue right now." />}
          columns={[
            { key: 'queue', header: 'Queue', render: (c) => <span className="mono">{c.queue}</span> },
            { key: 'tag', header: 'Consumer tag', render: (c) => <span className="mono subtle">{c.consumerTag}</span> },
            { key: 'channel', header: 'Channel', render: (c) => <span className="mono subtle">{c.channel}</span> },
            { key: 'ack', header: 'Ack', render: (c) => (c.ackRequired ? <Badge>manual</Badge> : <Badge tone="warning">auto</Badge>) },
            { key: 'prefetch', header: 'Prefetch', align: 'right', render: (c) => c.prefetchCount || '—' },
            { key: 'exclusive', header: 'Exclusive', render: (c) => (c.exclusive ? <Badge>yes</Badge> : '—') },
          ]}
        />
      )}

      {closing && (
        <ConfirmDialog
          danger
          title="Close this connection?"
          message="The client is disconnected. Most libraries reconnect automatically."
          confirmLabel="Close connection"
          onClose={() => setClosing(null)}
          onConfirm={async () => {
            try {
              await api.rabbitCloseConnection(cluster.id, closing);
              toast.success('Connection closed');
              connections.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
