import { useMemo, useState } from 'react';
import type { ClusterConfig, RabbitExchange } from '@shared/types';
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
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';
import { RabbitPublishModal } from './RabbitPublishModal';

const EXCHANGE_TYPES = ['direct', 'fanout', 'topic', 'headers'];

function ExchangeDetail({ cluster, name, onClose }: { cluster: ClusterConfig; name: string; onClose: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => api.rabbitExchange(cluster.id, name), [cluster.id, name]);
  const queues = useAsync(() => api.rabbitQueues(cluster.id), [cluster.id]);
  const [publishing, setPublishing] = useState(false);
  const [destination, setDestination] = useState('');
  const [routingKey, setRoutingKey] = useState('');

  return (
    <Modal
      wide
      title={
        <span>
          Exchange <span className="mono">{name || '(default)'}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button className="left" disabled={cluster.readonly} onClick={() => setPublishing(true)}>
            <Icon.Send width={14} /> Publish
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {detail.loading && <Loading />}
      {detail.error && <ErrorBanner error={detail.error} onRetry={detail.reload} />}
      {detail.data && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <Badge tone="accent">{detail.data.type}</Badge>
            {detail.data.durable && <Badge>durable</Badge>}
            {detail.data.autoDelete && <Badge>auto-delete</Badge>}
            {detail.data.internal && <Badge tone="warning">internal</Badge>}
            <Badge tone="info">in {detail.data.publishInRate.toFixed(1)}/s</Badge>
            <Badge tone="info">out {detail.data.publishOutRate.toFixed(1)}/s</Badge>
          </div>

          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Bindings</h3>
          <DataTable
            rows={detail.data.bindings}
            rowKey={(b) => `${b.destination}/${b.routingKey}/${b.propertiesKey}`}
            empty={<EmptyState title="Nothing bound to this exchange" description="Messages published here are dropped." />}
            columns={[
              {
                key: 'destination',
                header: 'To',
                render: (b) => (
                  <span>
                    <Badge>{b.destinationType}</Badge> <span className="mono">{b.destination}</span>
                  </span>
                ),
              },
              { key: 'routingKey', header: 'Routing key', render: (b) => <span className="mono">{b.routingKey || '—'}</span> },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (b) => (
                  <div className="row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      title="Delete binding"
                      disabled={cluster.readonly}
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
                ),
              },
            ]}
          />

          {!cluster.readonly && (
            <>
              <h3 style={{ fontSize: 13, margin: '18px 0 8px' }}>Bind a queue</h3>
              <div className="field-row" style={{ alignItems: 'end' }}>
                <Field label="Queue">
                  <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
                    <option value="">Choose a queue…</option>
                    {(queues.data ?? []).map((q) => (
                      <option key={q.name} value={q.name}>
                        {q.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Routing key">
                  <Input className="mono" value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} placeholder="orders.*" />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={!destination}
                    onClick={async () => {
                      try {
                        await api.rabbitCreateBinding(cluster.id, name, destination, { routingKey, destinationType: 'queue' });
                        toast.success('Binding created');
                        setDestination('');
                        setRoutingKey('');
                        detail.reload();
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    <Icon.Plus width={14} /> Bind
                  </Button>
                </Field>
              </div>
            </>
          )}
        </>
      )}

      {publishing && (
        <RabbitPublishModal
          cluster={cluster}
          defaultExchange={name}
          onClose={() => setPublishing(false)}
          onPublished={detail.reload}
        />
      )}
    </Modal>
  );
}

function CreateExchangeModal({ cluster, onClose, onDone }: { cluster: ClusterConfig; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState('topic');
  const [durable, setDurable] = useState(true);
  const [autoDelete, setAutoDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Create exchange"
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
                await api.rabbitCreateExchange(cluster.id, name.trim(), { type, durable, autoDelete });
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
            Create exchange
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input className="mono" autoFocus value={name} placeholder="orders" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {EXCHANGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <Checkbox checked={durable} onChange={setDurable} label="Durable — survives a broker restart" />
      </Field>
      <Field>
        <Checkbox checked={autoDelete} onChange={setAutoDelete} label="Auto-delete when the last binding is removed" />
      </Field>
    </Modal>
  );
}

export function RabbitExchangesPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const exchanges = useAsync(() => api.rabbitExchanges(cluster.id), [cluster.id]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RabbitExchange | null>(null);

  const rows = useMemo(
    () => (exchanges.data ?? []).filter((e) => !search || e.name.toLowerCase().includes(search.toLowerCase())),
    [exchanges.data, search],
  );

  return (
    <>
      <PageHead
        title="Exchanges"
        subtitle={exchanges.data ? `${rows.length} of ${exchanges.data.length} exchanges` : undefined}
        actions={
          <>
            <Button onClick={exchanges.reload} loading={exchanges.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setCreating(true)}>
              <Icon.Plus width={14} /> Create exchange
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter exchanges…" />
      </div>

      {exchanges.loading && <Loading />}
      {exchanges.error && <ErrorBanner error={exchanges.error} onRetry={exchanges.reload} />}
      {exchanges.data && (
        <DataTable
          rows={rows}
          rowKey={(e) => e.name || '(default)'}
          onRowClick={(e) => setSelected(e.name)}
          empty={<EmptyState icon={<Icon.Topics />} title="No exchanges" />}
          columns={[
            {
              key: 'name',
              header: 'Exchange',
              render: (e) => <span className="mono link-cell">{e.name || '(AMQP default)'}</span>,
            },
            { key: 'type', header: 'Type', render: (e) => <Badge tone="accent">{e.type}</Badge> },
            {
              key: 'features',
              header: 'Features',
              render: (e) => (
                <div className="chip-list">
                  {e.durable && <Badge>durable</Badge>}
                  {e.autoDelete && <Badge>auto-delete</Badge>}
                  {e.internal && <Badge tone="warning">internal</Badge>}
                </div>
              ),
            },
            { key: 'in', header: 'In/s', align: 'right', render: (e) => <span className="num subtle">{e.publishInRate.toFixed(1)}</span> },
            { key: 'out', header: 'Out/s', align: 'right', render: (e) => <span className="num subtle">{e.publishOutRate.toFixed(1)}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (e) =>
                e.name && !e.name.startsWith('amq.') ? (
                  <div className="row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      title="Delete exchange"
                      disabled={cluster.readonly}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleting(e);
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

      {selected !== null && <ExchangeDetail cluster={cluster} name={selected} onClose={() => setSelected(null)} />}
      {creating && <CreateExchangeModal cluster={cluster} onClose={() => setCreating(false)} onDone={exchanges.reload} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${deleting.name}?`}
          message="Bindings on this exchange go with it. Queues and their messages stay."
          confirmLabel="Delete exchange"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.rabbitDeleteExchange(cluster.id, deleting.name);
              toast.success('Exchange deleted');
              exchanges.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
