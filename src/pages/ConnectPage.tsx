import { useMemo, useState } from 'react';
import type { ClusterConfig, ConnectorSummary } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  CodeBlock,
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
  StateBadge,
  Tabs,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

function connectIdFor(cluster: ClusterConfig, connectName: string): string {
  return cluster.connects.find((c) => c.name === connectName)?.id ?? connectName;
}

function ConnectorDetailModal({
  cluster,
  connector,
  onClose,
  onChanged,
}: {
  cluster: ClusterConfig;
  connector: ConnectorSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connectId = connectIdFor(cluster, connector.connect);
  const detail = useAsync(() => api.connector(cluster.id, connectId, connector.name), [cluster.id, connectId, connector.name]);
  const [tab, setTab] = useState<'status' | 'config'>('status');
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const configText = useMemo(() => (detail.data ? JSON.stringify(detail.data.config, null, 2) : ''), [detail.data]);

  return (
    <Modal
      wide
      title={
        <span>
          <span className="mono">{connector.name}</span> <span className="subtle">on {connector.connect}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {tab === 'config' && (
            <Button
              variant="primary"
              loading={saving}
              disabled={cluster.readonly || draft === null}
              onClick={async () => {
                setSaving(true);
                try {
                  await api.updateConnectorConfig(cluster.id, connectId, connector.name, JSON.parse(draft ?? configText));
                  toast.success('Configuration applied');
                  setDraft(null);
                  detail.reload();
                  onChanged();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Apply config
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {detail.loading && <Loading />}
      {detail.error && <ErrorBanner error={detail.error} onRetry={detail.reload} />}
      {detail.data && (
        <>
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'status', label: 'Status' },
              { id: 'config', label: 'Configuration' },
            ]}
          />

          {tab === 'status' ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <StateBadge state={detail.data.state} />
                <Badge tone="accent">{detail.data.type}</Badge>
                <Badge>{detail.data.connectorClass.split('.').pop()}</Badge>
                <Badge>worker {detail.data.workerId}</Badge>
              </div>
              <DataTable
                rows={detail.data.tasks}
                rowKey={(t) => String(t.id)}
                empty={<EmptyState title="No tasks running" />}
                columns={[
                  { key: 'id', header: 'Task', render: (t) => <span className="mono">{t.id}</span> },
                  { key: 'state', header: 'State', render: (t) => <StateBadge state={t.state} /> },
                  { key: 'worker', header: 'Worker', render: (t) => <span className="mono subtle">{t.workerId}</span> },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    render: (t) => (
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={cluster.readonly}
                          onClick={async () => {
                            try {
                              await api.restartConnectorTask(cluster.id, connectId, connector.name, t.id);
                              toast.success(`Task ${t.id} restarting`);
                              detail.reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          Restart
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
              {detail.data.tasks.some((t) => t.trace) && (
                <>
                  <h3 style={{ fontSize: 12, margin: '16px 0 6px' }} className="subtle">
                    FAILURE TRACE
                  </h3>
                  <CodeBlock tall>{detail.data.tasks.map((t) => t.trace).filter(Boolean).join('\n\n')}</CodeBlock>
                </>
              )}
            </>
          ) : (
            <textarea
              className="textarea"
              rows={20}
              value={draft ?? configText}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function CreateConnectorModal({ cluster, onClose, onDone }: { cluster: ClusterConfig; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [connectId, setConnectId] = useState(cluster.connects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [config, setConfig] = useState(
    JSON.stringify(
      {
        'connector.class': 'org.apache.kafka.connect.file.FileStreamSinkConnector',
        'tasks.max': '1',
        topics: 'orders.v1',
        file: '/tmp/output.txt',
      },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const plugins = useAsync(() => api.connectorPlugins(cluster.id, connectId), [cluster.id, connectId], {
    enabled: Boolean(connectId),
  });

  return (
    <Modal
      wide
      title="Create connector"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !connectId}
            onClick={async () => {
              setBusy(true);
              try {
                await api.createConnector(cluster.id, connectId, name.trim(), JSON.parse(config));
                toast.success(`Created ${name}`);
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Connect cluster">
          <Select value={connectId} onChange={(e) => setConnectId(e.target.value)}>
            {cluster.connects.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="orders-sink" />
        </Field>
      </div>
      <Field
        label="Configuration (JSON)"
        hint={plugins.data ? `${plugins.data.length} plugins available on this worker` : undefined}
      >
        <textarea className="textarea" rows={16} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
      </Field>
    </Modal>
  );
}

export function ConnectPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const configured = (cluster.connects ?? []).length > 0;
  const connectors = useAsync(() => api.connectors(cluster.id), [cluster.id], { enabled: configured });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ConnectorSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ConnectorSummary | null>(null);

  const rows = useMemo(
    () =>
      (connectors.data ?? []).filter(
        (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.connectorClass.toLowerCase().includes(search.toLowerCase()),
      ),
    [connectors.data, search],
  );

  const act = async (connector: ConnectorSummary, action: 'pause' | 'resume' | 'restart') => {
    const connectId = connectIdFor(cluster, connector.connect);
    try {
      if (action === 'pause') await api.pauseConnector(cluster.id, connectId, connector.name);
      if (action === 'resume') await api.resumeConnector(cluster.id, connectId, connector.name);
      if (action === 'restart') await api.restartConnector(cluster.id, connectId, connector.name);
      toast.success(`${connector.name}: ${action} requested`);
      setTimeout(connectors.reload, 700);
    } catch (err) {
      toast.error(err);
    }
  };

  if (!configured) {
    return (
      <EmptyState
        icon={<Icon.Plug />}
        title="No Kafka Connect cluster configured"
        description="Add one or more Connect REST endpoints in the cluster settings to manage connectors from here."
      />
    );
  }

  return (
    <>
      <PageHead
        title="Kafka Connect"
        subtitle={cluster.connects.map((c) => `${c.name} → ${c.url}`).join(' · ')}
        actions={
          <>
            <Button onClick={connectors.reload} loading={connectors.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setCreating(true)}>
              <Icon.Plus width={14} /> Create connector
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter connectors…" />
      </div>

      {connectors.loading && <Loading />}
      {connectors.error && <ErrorBanner error={connectors.error} onRetry={connectors.reload} />}
      {connectors.data && (
        <DataTable
          rows={rows}
          rowKey={(c) => `${c.connect}/${c.name}`}
          onRowClick={(c) => c.state !== 'UNREACHABLE' && setSelected(c)}
          empty={<EmptyState icon={<Icon.Plug />} title="No connectors deployed" />}
          columns={[
            { key: 'name', header: 'Connector', render: (c) => <span className="mono link-cell">{c.name}</span> },
            { key: 'connect', header: 'Worker', render: (c) => <Badge>{c.connect}</Badge> },
            { key: 'state', header: 'State', render: (c) => <StateBadge state={c.state} /> },
            { key: 'type', header: 'Type', render: (c) => <Badge tone="accent">{c.type}</Badge> },
            {
              key: 'class',
              header: 'Class',
              render: (c) => <span className="mono subtle">{c.connectorClass.split('.').pop() ?? '—'}</span>,
            },
            {
              key: 'tasks',
              header: 'Tasks',
              align: 'right',
              render: (c) => {
                const running = c.tasks.filter((t) => t.state === 'RUNNING').length;
                return (
                  <span className="num" style={running < c.tasks.length ? { color: 'var(--warning)' } : undefined}>
                    {running}/{c.tasks.length}
                  </span>
                );
              },
            },
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
                    title={c.state === 'PAUSED' ? 'Resume' : 'Pause'}
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(c, c.state === 'PAUSED' ? 'resume' : 'pause');
                    }}
                  >
                    {c.state === 'PAUSED' ? <Icon.Play width={13} /> : <Icon.Pause width={13} />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Restart"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(c, 'restart');
                    }}
                  >
                    <Icon.Refresh width={13} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Delete"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(c);
                    }}
                  >
                    <Icon.Trash width={13} />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {selected && (
        <ConnectorDetailModal cluster={cluster} connector={selected} onClose={() => setSelected(null)} onChanged={connectors.reload} />
      )}
      {creating && <CreateConnectorModal cluster={cluster} onClose={() => setCreating(false)} onDone={connectors.reload} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${deleting.name}?`}
          message="The connector and its tasks are removed from the Connect cluster. Offsets it committed remain."
          confirmLabel="Delete connector"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteConnector(cluster.id, connectIdFor(cluster, deleting.connect), deleting.name);
              toast.success('Connector deleted');
              connectors.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
