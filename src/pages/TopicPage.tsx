import { useMemo, useState } from 'react';
import type { ClusterConfig, ConfigEntry } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Loading,
  Modal,
  SearchInput,
  Stat,
  Tabs,
} from '@/components/ui';
import { api } from '@/lib/api';
import { compactNumber, formatDuration, formatNumber } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';
import { useToast } from '@/lib/toast';
import { MessagesView } from './MessagesView';
import { ProduceModal } from './ProduceModal';

type TabId = 'overview' | 'messages' | 'consumers' | 'settings';

export function TopicPage({ cluster, topic, tab, onTabChange }: { cluster: ClusterConfig; topic: string; tab: TabId; onTabChange: (tab: TabId) => void }) {
  const toast = useToast();
  const detail = useAsync(() => api.topic(cluster.id, topic), [cluster.id, topic]);
  const [producing, setProducing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [addingPartitions, setAddingPartitions] = useState(false);

  if (detail.loading) return <Loading label={`Loading ${topic}…`} />;
  if (detail.error) return <ErrorBanner error={detail.error} onRetry={detail.reload} />;
  const data = detail.data!;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="mono" style={{ wordBreak: 'break-all' }}>
            {data.name}
          </h1>
          <p>
            {data.partitionCount} partitions · replication {data.replicationFactor} ·{' '}
            {compactNumber(data.messages)} messages
            {data.internal && (
              <>
                {' '}
                <Badge>internal</Badge>
              </>
            )}
            {data.underReplicated && (
              <>
                {' '}
                <Badge tone="warning">under-replicated</Badge>
              </>
            )}
          </p>
        </div>
        <div className="actions">
          <Button onClick={detail.reload} loading={detail.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
          <Button variant="primary" disabled={cluster.readonly} onClick={() => setProducing(true)}>
            <Icon.Send width={14} /> Produce
          </Button>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={onTabChange}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'messages', label: 'Messages' },
          { id: 'consumers', label: 'Consumers' },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'overview' && (
        <>
          <div className="stat-grid">
            <Stat label="Partitions" value={data.partitionCount} />
            <Stat label="Replication factor" value={data.replicationFactor} />
            <Stat
              label="Out of sync"
              value={data.outOfSyncReplicas}
              tone={data.outOfSyncReplicas > 0 ? 'warning' : undefined}
            />
            <Stat label="Messages" value={compactNumber(data.messages)} />
            <Stat label="Cleanup policy" value={<span style={{ fontSize: 17 }}>{data.cleanupPolicy}</span>} />
            <Stat label="Retention" value={<span style={{ fontSize: 17 }}>{formatDuration(data.retentionMs)}</span>} />
          </div>

          <DataTable
            rows={data.partitions}
            rowKey={(p) => String(p.partitionId)}
            columns={[
              { key: 'id', header: 'Partition', render: (p) => <span className="mono">{p.partitionId}</span> },
              {
                key: 'leader',
                header: 'Leader',
                render: (p) => (p.leader >= 0 ? <span className="mono">{p.leader}</span> : <Badge tone="danger">none</Badge>),
              },
              { key: 'replicas', header: 'Replicas', render: (p) => <span className="mono">{p.replicas.join(', ')}</span> },
              {
                key: 'isr',
                header: 'In-sync',
                render: (p) => (
                  <span className={p.isr.length < p.replicas.length ? '' : 'mono'} style={p.isr.length < p.replicas.length ? { color: 'var(--warning)' } : undefined}>
                    {p.isr.join(', ') || '—'}
                  </span>
                ),
              },
              { key: 'low', header: 'Earliest', align: 'right', render: (p) => <span className="mono">{p.low}</span> },
              { key: 'high', header: 'Latest', align: 'right', render: (p) => <span className="mono">{p.high}</span> },
              {
                key: 'messages',
                header: 'Messages',
                align: 'right',
                render: (p) => <span className="num">{formatNumber(p.messages)}</span>,
              },
            ]}
          />
        </>
      )}

      {tab === 'messages' && (
        <div style={{ margin: '-16px -24px -40px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 480 }}>
          <MessagesView cluster={cluster} topic={topic} partitionCount={data.partitionCount} />
        </div>
      )}

      {tab === 'consumers' && <TopicConsumers cluster={cluster} topic={topic} />}

      {tab === 'settings' && (
        <TopicSettings
          cluster={cluster}
          topic={topic}
          configs={data.configs}
          onSaved={detail.reload}
          onAddPartitions={() => setAddingPartitions(true)}
          onPurge={() => setPurging(true)}
          onDelete={() => setDeleting(true)}
        />
      )}

      {producing && (
        <ProduceModal
          cluster={cluster}
          topic={topic}
          partitionCount={data.partitionCount}
          onClose={() => setProducing(false)}
          onProduced={detail.reload}
        />
      )}

      {addingPartitions && (
        <AddPartitionsModal
          cluster={cluster}
          topic={topic}
          current={data.partitionCount}
          onClose={() => setAddingPartitions(false)}
          onDone={detail.reload}
        />
      )}

      {purging && (
        <ConfirmDialog
          danger
          title={`Purge ${topic}?`}
          requireText={topic}
          message="All records up to the current end offset are deleted. Partitions and configuration stay as they are."
          confirmLabel="Purge messages"
          onClose={() => setPurging(false)}
          onConfirm={async () => {
            try {
              await api.purgeTopic(cluster.id, topic);
              toast.success('Topic purged');
              detail.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${topic}?`}
          requireText={topic}
          message="The topic and every message in it are destroyed. This cannot be undone."
          confirmLabel="Delete topic"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await api.deleteTopic(cluster.id, topic);
              toast.success(`Deleted ${topic}`);
              navigate(`/c/${cluster.id}/topics`);
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}

function AddPartitionsModal({
  cluster,
  topic,
  current,
  onClose,
  onDone,
}: {
  cluster: ClusterConfig;
  topic: string;
  current: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [total, setTotal] = useState(current + 1);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Add partitions"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={total <= current}
            onClick={async () => {
              setBusy(true);
              try {
                await api.addPartitions(cluster.id, topic, total);
                toast.success(`${topic} now has ${total} partitions`);
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add partitions
          </Button>
        </>
      }
    >
      <div className="warn-banner">
        <Icon.Alert width={16} />
        <div>Partitions can only be added, never removed. Keyed ordering guarantees change once the count changes.</div>
      </div>
      <Field label="Total partitions" hint={`Currently ${current}`}>
        <Input type="number" min={current + 1} value={total} onChange={(e) => setTotal(Number(e.target.value))} />
      </Field>
    </Modal>
  );
}

function TopicConsumers({ cluster, topic }: { cluster: ClusterConfig; topic: string }) {
  const groups = useAsync(() => api.groups(cluster.id), [cluster.id]);
  const rows = useMemo(() => (groups.data ?? []).filter((g) => g.topics.includes(topic)), [groups.data, topic]);

  if (groups.loading) return <Loading />;
  if (groups.error) return <ErrorBanner error={groups.error} onRetry={groups.reload} />;

  return (
    <DataTable
      rows={rows}
      rowKey={(g) => g.groupId}
      onRowClick={(g) => navigate(`/c/${cluster.id}/groups/${encodeURIComponent(g.groupId)}`)}
      empty={<EmptyState icon={<Icon.Groups />} title="No consumer group is reading this topic" />}
      columns={[
        { key: 'groupId', header: 'Group', render: (g) => <span className="mono link-cell">{g.groupId}</span> },
        { key: 'state', header: 'State', render: (g) => <Badge tone={g.state === 'Stable' ? 'success' : 'info'}>{g.state}</Badge> },
        { key: 'members', header: 'Members', align: 'right', render: (g) => g.members },
        { key: 'lag', header: 'Lag', align: 'right', render: (g) => <span className="num">{formatNumber(g.lag)}</span> },
      ]}
    />
  );
}

function TopicSettings({
  cluster,
  topic,
  configs,
  onSaved,
  onAddPartitions,
  onPurge,
  onDelete,
}: {
  cluster: ClusterConfig;
  topic: string;
  configs: ConfigEntry[];
  onSaved: () => void;
  onAddPartitions: () => void;
  onPurge: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const rows = useMemo(
    () => configs.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())),
    [configs, search],
  );
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateTopicConfig(
        cluster.id,
        topic,
        Object.entries(edits).map(([name, value]) => ({ name, value })),
      );
      toast.success('Configuration updated');
      setEdits({});
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter configuration…" />
        <Button onClick={onAddPartitions} disabled={cluster.readonly}>
          <Icon.Plus width={14} /> Add partitions
        </Button>
        <Button variant="danger" onClick={onPurge} disabled={cluster.readonly}>
          Purge messages
        </Button>
        <Button variant="danger" onClick={onDelete} disabled={cluster.readonly}>
          <Icon.Trash width={14} /> Delete topic
        </Button>
        {dirty && (
          <Button variant="primary" loading={saving} onClick={save}>
            Save {Object.keys(edits).length} change(s)
          </Button>
        )}
      </div>

      <DataTable
        rows={rows}
        rowKey={(c) => c.name}
        columns={[
          { key: 'name', header: 'Key', width: '38%', render: (c) => <span className="mono">{c.name}</span> },
          {
            key: 'value',
            header: 'Value',
            render: (c) =>
              c.isReadOnly || cluster.readonly ? (
                <span className="mono">{c.isSensitive ? '•••••' : (c.value ?? '—')}</span>
              ) : (
                <Input
                  className="mono"
                  value={edits[c.name] ?? c.value ?? ''}
                  onChange={(e) => setEdits({ ...edits, [c.name]: e.target.value })}
                />
              ),
          },
          {
            key: 'source',
            header: 'Source',
            width: 130,
            render: (c) => (c.isDefault ? <Badge>default</Badge> : <Badge tone="accent">overridden</Badge>),
          },
        ]}
      />
    </>
  );
}
