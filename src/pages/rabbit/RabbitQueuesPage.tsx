import { useMemo, useState } from 'react';
import type { ClusterConfig, RabbitMessage, RabbitQueue } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
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
import { compactNumber, formatBytes, formatNumber } from '@/lib/format';
import { useAsync, useSort } from '@/lib/hooks';
import { useToast } from '@/lib/toast';
import { RabbitPublishModal } from './RabbitPublishModal';

function MessageList({ cluster, queue }: { cluster: ClusterConfig; queue: string }) {
  const toast = useToast();
  const [count, setCount] = useState(20);
  const [requeue, setRequeue] = useState(true);
  const [messages, setMessages] = useState<RabbitMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const fetchMessages = async () => {
    setBusy(true);
    try {
      setMessages(await api.rabbitGetMessages(cluster.id, queue, count, requeue));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="toolbar">
        <Field label="Messages">
          <Input type="number" min={1} style={{ width: 90 }} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </Field>
        <Field label="Acknowledgement">
          <Select value={requeue ? 'requeue' : 'ack'} onChange={(e) => setRequeue(e.target.value === 'requeue')}>
            <option value="requeue">Peek — put back on the queue</option>
            <option value="ack">Consume — remove from the queue</option>
          </Select>
        </Field>
        <Button variant="primary" loading={busy} onClick={fetchMessages}>
          <Icon.Play width={14} /> Get messages
        </Button>
      </div>

      {!requeue && (
        <div className="warn-banner">
          <Icon.Alert width={16} />
          <div>Consume mode acknowledges the messages — they are gone from the queue for good.</div>
        </div>
      )}

      {messages === null ? (
        <EmptyState icon={<Icon.Inbox />} title="Nothing fetched yet" description="Get messages reads from the head of the queue." />
      ) : messages.length === 0 ? (
        <EmptyState icon={<Icon.Inbox />} title="The queue is empty" />
      ) : (
        <DataTable
          rows={messages.map((m, i) => ({ ...m, index: i }))}
          rowKey={(m) => String(m.index)}
          onRowClick={(m) => setOpen(m.index)}
          columns={[
            { key: 'routingKey', header: 'Routing key', render: (m) => <span className="mono link-cell">{m.routingKey || '—'}</span> },
            { key: 'exchange', header: 'Exchange', render: (m) => <span className="mono">{m.exchange || '(default)'}</span> },
            {
              key: 'payload',
              header: 'Payload',
              render: (m) => <div className="msg-preview">{m.payload.slice(0, 400)}</div>,
            },
            { key: 'size', header: 'Size', align: 'right', render: (m) => <span className="mono subtle">{formatBytes(m.payloadBytes)}</span> },
            {
              key: 'flags',
              header: '',
              align: 'right',
              render: (m) => (m.redelivered ? <Badge tone="warning">redelivered</Badge> : null),
            },
          ]}
        />
      )}

      {open !== null && messages?.[open] && (
        <Modal
          wide
          title="Message"
          onClose={() => setOpen(null)}
          footer={
            <>
              <CopyButton label="Copy payload" text={messages[open].payload} />
              <Button onClick={() => setOpen(null)}>Close</Button>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <Badge tone="accent">{messages[open].routingKey || 'no routing key'}</Badge>
            <Badge>{messages[open].exchange || '(default exchange)'}</Badge>
            <Badge>{formatBytes(messages[open].payloadBytes)}</Badge>
            <Badge>{messages[open].payloadEncoding}</Badge>
          </div>
          <h3 className="subtle" style={{ fontSize: 12, marginBottom: 6 }}>
            PAYLOAD
          </h3>
          <CodeBlock language={messages[open].payload.trimStart().startsWith('{') ? 'json' : 'text'} tall>
            {messages[open].payload}
          </CodeBlock>
          <h3 className="subtle" style={{ fontSize: 12, margin: '16px 0 6px' }}>
            PROPERTIES
          </h3>
          <CodeBlock language="json">{JSON.stringify(messages[open].properties, null, 2)}</CodeBlock>
        </Modal>
      )}
    </>
  );
}

function QueueDetail({ cluster, name, onClose, onChanged }: { cluster: ClusterConfig; name: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => api.rabbitQueue(cluster.id, name), [cluster.id, name]);
  const [tab, setTab] = useState<'messages' | 'bindings' | 'details'>('messages');
  const [publishing, setPublishing] = useState(false);
  const [purging, setPurging] = useState(false);

  return (
    <Modal
      wide
      title={
        <span>
          Queue <span className="mono">{name}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button className="left" disabled={cluster.readonly} onClick={() => setPublishing(true)}>
            <Icon.Send width={14} /> Publish
          </Button>
          <Button variant="danger" disabled={cluster.readonly} onClick={() => setPurging(true)}>
            Purge
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {detail.loading && <Loading />}
      {detail.error && <ErrorBanner error={detail.error} onRetry={detail.reload} />}
      {detail.data && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <StateBadge state={detail.data.state} />
            <Badge tone="accent">{detail.data.type}</Badge>
            {detail.data.durable && <Badge>durable</Badge>}
            {detail.data.autoDelete && <Badge>auto-delete</Badge>}
            {detail.data.exclusive && <Badge>exclusive</Badge>}
            <Badge tone="info">{formatNumber(detail.data.messages)} messages</Badge>
            <Badge>{detail.data.consumers} consumers</Badge>
            <Badge>{formatBytes(detail.data.memory)}</Badge>
          </div>

          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'messages', label: 'Messages' },
              { id: 'bindings', label: 'Bindings', badge: detail.data.bindings.length },
              { id: 'details', label: 'Details' },
            ]}
          />

          {tab === 'messages' && <MessageList cluster={cluster} queue={name} />}

          {tab === 'bindings' && (
            <DataTable
              rows={detail.data.bindings}
              rowKey={(b, ) => `${b.source}/${b.routingKey}/${b.propertiesKey}`}
              empty={<EmptyState title="No bindings" description="Only the default exchange routes to this queue." />}
              columns={[
                { key: 'source', header: 'From exchange', render: (b) => <span className="mono">{b.source || '(default)'}</span> },
                { key: 'routingKey', header: 'Routing key', render: (b) => <span className="mono">{b.routingKey || '—'}</span> },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (b) =>
                    b.source ? (
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          disabled={cluster.readonly}
                          title="Delete binding"
                          onClick={async () => {
                            try {
                              await api.rabbitDeleteBinding(cluster.id, b);
                              toast.success('Binding removed');
                              detail.reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          <Icon.Trash width={14} />
                        </Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          )}

          {tab === 'details' && (
            <CodeBlock language="json" tall>
              {JSON.stringify(
                {
                  node: detail.data.node,
                  ready: detail.data.ready,
                  unacknowledged: detail.data.unacknowledged,
                  publishRate: detail.data.publishRate,
                  deliverRate: detail.data.deliverRate,
                  policy: detail.data.policy,
                  arguments: detail.data.arguments,
                },
                null,
                2,
              )}
            </CodeBlock>
          )}
        </>
      )}

      {publishing && (
        <RabbitPublishModal
          cluster={cluster}
          defaultRoutingKey={name}
          onClose={() => setPublishing(false)}
          onPublished={() => {
            detail.reload();
            onChanged();
          }}
        />
      )}

      {purging && (
        <ConfirmDialog
          danger
          title={`Purge ${name}?`}
          requireText={name}
          message="Every message currently in the queue is discarded."
          confirmLabel="Purge queue"
          onClose={() => setPurging(false)}
          onConfirm={async () => {
            try {
              await api.rabbitPurgeQueue(cluster.id, name);
              toast.success('Queue purged');
              detail.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </Modal>
  );
}

function CreateQueueModal({ cluster, onClose, onDone }: { cluster: ClusterConfig; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [durable, setDurable] = useState(true);
  const [autoDelete, setAutoDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Create queue"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.rabbitCreateQueue(cluster.id, name.trim(), { durable, autoDelete });
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
            Create queue
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input className="mono" autoFocus value={name} placeholder="orders.processing" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field>
        <Checkbox checked={durable} onChange={setDurable} label="Durable — survives a broker restart" />
      </Field>
      <Field>
        <Checkbox checked={autoDelete} onChange={setAutoDelete} label="Auto-delete when the last consumer disconnects" />
      </Field>
    </Modal>
  );
}

export function RabbitQueuesPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const queues = useAsync(() => api.rabbitQueues(cluster.id), [cluster.id]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState<RabbitQueue | null>(null);
  const sorter = useSort<RabbitQueue & Record<string, unknown>>('name');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (queues.data ?? []).filter((q) => !needle || q.name.toLowerCase().includes(needle));
    return sorter.sort(filtered as (RabbitQueue & Record<string, unknown>)[]);
  }, [queues.data, search, sorter]);

  return (
    <>
      <PageHead
        title="Queues"
        subtitle={queues.data ? `${formatNumber(rows.length)} of ${formatNumber(queues.data.length)} queues in ${cluster.rabbit?.vhost}` : undefined}
        actions={
          <>
            <Button onClick={queues.reload} loading={queues.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button disabled={cluster.readonly} onClick={() => setPublishing(true)}>
              <Icon.Send width={14} /> Publish
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setCreating(true)}>
              <Icon.Plus width={14} /> Create queue
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter queues…" />
      </div>

      {queues.loading && <Loading />}
      {queues.error && <ErrorBanner error={queues.error} onRetry={queues.reload} />}
      {queues.data && (
        <DataTable
          rows={rows}
          rowKey={(q) => q.name}
          sortKey={sorter.key}
          sortDirection={sorter.direction}
          onSort={(key) => sorter.toggle(key as never)}
          onRowClick={(q) => setSelected(q.name)}
          empty={
            <EmptyState
              icon={<Icon.Inbox />}
              title={search ? 'No queues match that filter' : 'No queues yet'}
              action={
                !search && !cluster.readonly ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Icon.Plus width={14} /> Create queue
                  </Button>
                ) : undefined
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Queue',
              sortable: true,
              render: (q) => (
                <span>
                  <span className="mono link-cell">{q.name}</span>{' '}
                  {q.durable && <Badge>D</Badge>} {q.autoDelete && <Badge>AD</Badge>} {q.exclusive && <Badge>EX</Badge>}
                </span>
              ),
            },
            { key: 'type', header: 'Type', sortable: true, render: (q) => <Badge tone="accent">{q.type}</Badge> },
            { key: 'state', header: 'State', sortable: true, render: (q) => <StateBadge state={q.state} /> },
            { key: 'ready', header: 'Ready', sortable: true, align: 'right', render: (q) => <span className="num">{compactNumber(q.ready)}</span> },
            {
              key: 'unacknowledged',
              header: 'Unacked',
              sortable: true,
              align: 'right',
              render: (q) => (
                <span className="num" style={q.unacknowledged > 0 ? { color: 'var(--warning)' } : undefined}>
                  {compactNumber(q.unacknowledged)}
                </span>
              ),
            },
            { key: 'messages', header: 'Total', sortable: true, align: 'right', render: (q) => <span className="num">{compactNumber(q.messages)}</span> },
            { key: 'consumers', header: 'Consumers', sortable: true, align: 'right', render: (q) => q.consumers },
            {
              key: 'publishRate',
              header: 'In/s',
              sortable: true,
              align: 'right',
              render: (q) => <span className="num subtle">{q.publishRate.toFixed(1)}</span>,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (q) => (
                <div className="row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Purge"
                    disabled={cluster.readonly}
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.rabbitPurgeQueue(cluster.id, q.name);
                        toast.success(`Purged ${q.name}`);
                        queues.reload();
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    <Icon.Zap width={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Delete queue"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(q);
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

      {selected && <QueueDetail cluster={cluster} name={selected} onClose={() => setSelected(null)} onChanged={queues.reload} />}
      {creating && <CreateQueueModal cluster={cluster} onClose={() => setCreating(false)} onDone={queues.reload} />}
      {publishing && (
        <RabbitPublishModal cluster={cluster} onClose={() => setPublishing(false)} onPublished={queues.reload} />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${deleting.name}?`}
          requireText={deleting.name}
          message="The queue and every message in it are removed from the broker."
          confirmLabel="Delete queue"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.rabbitDeleteQueue(cluster.id, deleting.name);
              toast.success('Queue deleted');
              queues.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
