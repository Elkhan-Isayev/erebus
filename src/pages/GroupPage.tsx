import { useMemo, useState } from 'react';
import type { ClusterConfig, ResetOffsetMode } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  ErrorBanner,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Stat,
  StateBadge,
  Tabs,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';
import { useToast } from '@/lib/toast';

function ResetOffsetsModal({
  cluster,
  groupId,
  topics,
  onClose,
  onDone,
}: {
  cluster: ClusterConfig;
  groupId: string;
  topics: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [topic, setTopic] = useState(topics[0] ?? '');
  const [mode, setMode] = useState<ResetOffsetMode>('earliest');
  const [value, setValue] = useState('');
  const [partitions, setPartitions] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Reset offsets"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!topic}
            onClick={async () => {
              setBusy(true);
              try {
                await api.resetOffsets({
                  clusterId: cluster.id,
                  groupId,
                  topic,
                  mode,
                  value: value || undefined,
                  partitions: partitions
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean)
                    .map(Number)
                    .filter((p) => Number.isInteger(p) && p >= 0),
                });
                toast.success('Offsets reset');
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Reset offsets
          </Button>
        </>
      }
    >
      <div className="warn-banner">
        <Icon.Alert width={16} />
        <div>Kafka refuses offset resets while the group has active members. Stop the consumers first.</div>
      </div>

      <Field label="Topic">
        <Select value={topic} onChange={(e) => setTopic(e.target.value)}>
          {topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Reset to">
        <Select value={mode} onChange={(e) => setMode(e.target.value as ResetOffsetMode)}>
          <option value="earliest">Earliest offset</option>
          <option value="latest">Latest offset</option>
          <option value="offset">Specific offset</option>
          <option value="timestamp">Timestamp</option>
        </Select>
      </Field>

      {mode === 'offset' && (
        <Field label="Offset">
          <Input className="mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" />
        </Field>
      )}
      {mode === 'timestamp' && (
        <Field label="Timestamp">
          <Input
            type="datetime-local"
            onChange={(e) => setValue(e.target.value ? String(new Date(e.target.value).getTime()) : '')}
          />
        </Field>
      )}

      <Field label="Partitions" hint="Comma separated, empty means every partition">
        <Input className="mono" value={partitions} onChange={(e) => setPartitions(e.target.value)} placeholder="0, 1, 2" />
      </Field>
    </Modal>
  );
}

export function GroupPage({ cluster, groupId }: { cluster: ClusterConfig; groupId: string }) {
  const toast = useToast();
  const group = useAsync(() => api.group(cluster.id, groupId), [cluster.id, groupId]);
  const [tab, setTab] = useState<'offsets' | 'members'>('offsets');
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const totalLag = useMemo(
    () => (group.data?.offsets ?? []).reduce((sum, o) => sum + Number(o.lag || 0), 0),
    [group.data],
  );

  if (group.loading) return <Loading label="Describing group…" />;
  if (group.error) return <ErrorBanner error={group.error} onRetry={group.reload} />;
  const data = group.data!;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="mono" style={{ wordBreak: 'break-all' }}>
            {data.groupId}
          </h1>
          <p>
            <StateBadge state={data.state} /> · {data.members} member(s) · protocol{' '}
            <span className="mono">{data.protocol || 'n/a'}</span>
          </p>
        </div>
        <div className="actions">
          <Button onClick={group.reload} loading={group.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
          <Button disabled={cluster.readonly || data.topics.length === 0} onClick={() => setResetting(true)}>
            <Icon.Clock width={14} /> Reset offsets
          </Button>
          <Button variant="danger" disabled={cluster.readonly} onClick={() => setDeleting(true)}>
            <Icon.Trash width={14} /> Delete group
          </Button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Total lag" value={formatNumber(totalLag)} tone={totalLag > 0 ? 'warning' : undefined} />
        <Stat label="Members" value={data.members} />
        <Stat label="Topics" value={data.topics.length} />
        <Stat label="Assigned partitions" value={data.offsets.length} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'offsets', label: 'Offsets', badge: data.offsets.length },
          { id: 'members', label: 'Members', badge: data.membersDetail.length },
        ]}
      />

      {tab === 'offsets' && (
        <DataTable
          rows={data.offsets}
          rowKey={(o) => `${o.topic}/${o.partition}`}
          onRowClick={(o) => navigate(`/c/${cluster.id}/topics/${encodeURIComponent(o.topic)}?tab=messages`)}
          columns={[
            { key: 'topic', header: 'Topic', render: (o) => <span className="mono link-cell">{o.topic}</span> },
            { key: 'partition', header: 'Partition', align: 'right', render: (o) => <span className="mono">{o.partition}</span> },
            { key: 'current', header: 'Committed', align: 'right', render: (o) => <span className="mono">{o.currentOffset}</span> },
            { key: 'end', header: 'End offset', align: 'right', render: (o) => <span className="mono">{o.endOffset}</span> },
            {
              key: 'lag',
              header: 'Lag',
              align: 'right',
              render: (o) => (
                <span className="num" style={Number(o.lag) > 0 ? { color: 'var(--warning)' } : undefined}>
                  {formatNumber(o.lag)}
                </span>
              ),
            },
            {
              key: 'owner',
              header: 'Consumer',
              render: (o) =>
                o.memberId ? (
                  <span className="mono subtle" title={o.memberId}>
                    {o.clientHost} {o.memberId.slice(0, 18)}…
                  </span>
                ) : (
                  <Badge tone="warning">unassigned</Badge>
                ),
            },
          ]}
        />
      )}

      {tab === 'members' && (
        <DataTable
          rows={data.membersDetail}
          rowKey={(m) => m.memberId}
          columns={[
            { key: 'clientId', header: 'Client id', render: (m) => <span className="mono">{m.clientId}</span> },
            { key: 'host', header: 'Host', render: (m) => <span className="mono">{m.clientHost}</span> },
            { key: 'memberId', header: 'Member id', render: (m) => <span className="mono subtle">{m.memberId}</span> },
            {
              key: 'assignments',
              header: 'Assignment',
              render: (m) => (
                <div className="chip-list">
                  {m.assignments.map((a) => (
                    <Badge key={a.topic}>
                      {a.topic}: {a.partitions.join(', ')}
                    </Badge>
                  ))}
                  {m.assignments.length === 0 && <span className="subtle">none</span>}
                </div>
              ),
            },
          ]}
        />
      )}

      {resetting && (
        <ResetOffsetsModal
          cluster={cluster}
          groupId={groupId}
          topics={data.topics}
          onClose={() => setResetting(false)}
          onDone={group.reload}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${groupId}?`}
          message="The group and its committed offsets are removed from the cluster. Active members must be stopped first."
          confirmLabel="Delete group"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await api.deleteGroup(cluster.id, groupId);
              toast.success('Group deleted');
              navigate(`/c/${cluster.id}/groups`);
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
