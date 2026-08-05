import { useMemo, useState } from 'react';
import type { ClusterConfig, CreateTopicInput, TopicSummary } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Loading,
  Modal,
  PageHead,
  SearchInput,
  Select,
} from '@/components/ui';
import { api } from '@/lib/api';
import { compactNumber, formatDuration, formatNumber } from '@/lib/format';
import { useAsync, useSort } from '@/lib/hooks';
import { navigate } from '@/lib/router';
import { useToast } from '@/lib/toast';
import { useAppState } from '@/app/AppState';

const CLEANUP_POLICIES = ['delete', 'compact', 'compact,delete'];

function CreateTopicModal({
  cluster,
  onClose,
  onCreated,
}: {
  cluster: ClusterConfig;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<CreateTopicInput>({
    name: '',
    numPartitions: 1,
    replicationFactor: 1,
    configs: { 'cleanup.policy': 'delete', 'retention.ms': '604800000' },
  });
  const [extra, setExtra] = useState<{ name: string; value: string }[]>([]);

  const create = async () => {
    if (!draft.name.trim()) return toast.error('Topic name is required');
    setBusy(true);
    try {
      const configs = { ...draft.configs };
      for (const entry of extra) if (entry.name.trim()) configs[entry.name.trim()] = entry.value;
      await api.createTopic(cluster.id, { ...draft, name: draft.name.trim(), configs });
      toast.success(`Created ${draft.name}`);
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create topic"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Create topic
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          className="mono"
          autoFocus
          value={draft.name}
          placeholder="orders.v1"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </Field>
      <div className="field-row">
        <Field label="Partitions">
          <Input
            type="number"
            min={1}
            value={draft.numPartitions}
            onChange={(e) => setDraft({ ...draft, numPartitions: Number(e.target.value) })}
          />
        </Field>
        <Field label="Replication factor">
          <Input
            type="number"
            min={1}
            value={draft.replicationFactor}
            onChange={(e) => setDraft({ ...draft, replicationFactor: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Cleanup policy">
          <Select
            value={draft.configs['cleanup.policy']}
            onChange={(e) => setDraft({ ...draft, configs: { ...draft.configs, 'cleanup.policy': e.target.value } })}
          >
            {CLEANUP_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {policy}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Retention (ms)" hint="-1 keeps messages forever">
          <Input
            className="mono"
            value={draft.configs['retention.ms']}
            onChange={(e) => setDraft({ ...draft, configs: { ...draft.configs, 'retention.ms': e.target.value } })}
          />
        </Field>
      </div>

      <Field label="Additional configuration">
        {extra.map((entry, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input
              className="mono"
              placeholder="max.message.bytes"
              value={entry.name}
              onChange={(e) => setExtra(extra.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)))}
            />
            <Input
              className="mono"
              placeholder="1048588"
              value={entry.value}
              onChange={(e) => setExtra(extra.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)))}
            />
            <Button variant="ghost" iconOnly onClick={() => setExtra(extra.filter((_, i) => i !== index))}>
              <Icon.Trash width={14} />
            </Button>
          </div>
        ))}
        <Button size="sm" onClick={() => setExtra([...extra, { name: '', value: '' }])}>
          <Icon.Plus width={13} /> Add config
        </Button>
      </Field>
    </Modal>
  );
}

export function TopicsPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const { settings, saveSettings } = useAppState();
  const topics = useAsync(() => api.topics(cluster.id), [cluster.id]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TopicSummary | null>(null);
  const [purging, setPurging] = useState<TopicSummary | null>(null);
  const sorter = useSort<TopicSummary & Record<string, unknown>>('name');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (topics.data ?? []).filter(
      (t) => (settings.showInternalTopics || !t.internal) && (!needle || t.name.toLowerCase().includes(needle)),
    );
    return sorter.sort(filtered as (TopicSummary & Record<string, unknown>)[]);
  }, [topics.data, search, settings.showInternalTopics, sorter]);

  return (
    <>
      <PageHead
        title="Topics"
        subtitle={topics.data ? `${formatNumber(rows.length)} of ${formatNumber(topics.data.length)} topics` : undefined}
        actions={
          <>
            <Button onClick={topics.reload} loading={topics.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setCreating(true)}>
              <Icon.Plus width={14} /> Create topic
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter topics…" />
        <Checkbox
          checked={settings.showInternalTopics}
          onChange={(showInternalTopics) => void saveSettings({ showInternalTopics })}
          label="Show internal"
        />
      </div>

      {topics.loading && <Loading label="Reading topic metadata…" />}
      {topics.error && <ErrorBanner error={topics.error} onRetry={topics.reload} />}
      {topics.data && (
        <DataTable
          rows={rows}
          rowKey={(t) => t.name}
          sortKey={sorter.key}
          sortDirection={sorter.direction}
          onSort={(key) => sorter.toggle(key as never)}
          onRowClick={(t) => navigate(`/c/${cluster.id}/topics/${encodeURIComponent(t.name)}`)}
          empty={
            <EmptyState
              icon={<Icon.Topics />}
              title={search ? 'No topics match that filter' : 'No topics yet'}
              description={search ? undefined : 'Create your first topic to start producing messages.'}
              action={
                !search && !cluster.readonly ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Icon.Plus width={14} /> Create topic
                  </Button>
                ) : undefined
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Topic',
              sortable: true,
              render: (t) => (
                <span>
                  <span className="link-cell mono">{t.name}</span>{' '}
                  {t.internal && <Badge>internal</Badge>}
                  {t.underReplicated && <Badge tone="warning">under-replicated</Badge>}
                </span>
              ),
            },
            { key: 'partitionCount', header: 'Partitions', sortable: true, align: 'right', render: (t) => t.partitionCount },
            {
              key: 'replicationFactor',
              header: 'Replication',
              sortable: true,
              align: 'right',
              render: (t) => t.replicationFactor,
            },
            {
              key: 'outOfSyncReplicas',
              header: 'Out of sync',
              sortable: true,
              align: 'right',
              render: (t) =>
                t.outOfSyncReplicas > 0 ? <span style={{ color: 'var(--warning)' }}>{t.outOfSyncReplicas}</span> : '0',
            },
            {
              key: 'messages',
              header: 'Messages',
              sortable: true,
              align: 'right',
              render: (t) => <span className="num">{compactNumber(t.messages)}</span>,
            },
            { key: 'cleanupPolicy', header: 'Cleanup', sortable: true, render: (t) => <Badge>{t.cleanupPolicy}</Badge> },
            {
              key: 'retentionMs',
              header: 'Retention',
              sortable: true,
              align: 'right',
              render: (t) => <span className="num">{formatDuration(t.retentionMs)}</span>,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (t) => (
                <div className="row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Browse messages"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/c/${cluster.id}/topics/${encodeURIComponent(t.name)}?tab=messages`);
                    }}
                  >
                    <Icon.Inbox width={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Purge messages"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPurging(t);
                    }}
                  >
                    <Icon.Zap width={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Delete topic"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(t);
                    }}
                  >
                    <Icon.Trash width={14} />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {creating && <CreateTopicModal cluster={cluster} onClose={() => setCreating(false)} onCreated={topics.reload} />}

      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${deleting.name}?`}
          requireText={deleting.name}
          message="Every message and partition in this topic is destroyed. This cannot be undone."
          confirmLabel="Delete topic"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteTopic(cluster.id, deleting.name);
              toast.success(`Deleted ${deleting.name}`);
              topics.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}

      {purging && (
        <ConfirmDialog
          danger
          title={`Purge ${purging.name}?`}
          requireText={purging.name}
          message="All records are deleted up to the current end offset. The topic and its partitions stay in place."
          confirmLabel="Purge messages"
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            try {
              await api.purgeTopic(cluster.id, purging.name);
              toast.success(`Purged ${purging.name}`);
              topics.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
