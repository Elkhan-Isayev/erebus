import { useState } from 'react';
import type { BrokerKind, ClusterConfig, KafkaConnectConfig, SaslMechanism } from '@shared/types';
import { Button, Checkbox, Field, Input, Modal, Segmented, Select, Tabs, Textarea } from '@/components/ui';
import { Icon } from '@/components/Icons';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';

const COLORS = ['#7c5cff', '#2f9e6e', '#d97706', '#dc2626', '#0ea5e9', '#db2777', '#65a30d', '#6b7280'];

const emptyCluster = (): Partial<ClusterConfig> => ({
  name: '',
  kind: 'kafka',
  rabbit: null,
  bootstrapServers: 'localhost:9092',
  clientId: 'erebus',
  color: COLORS[0],
  readonly: false,
  ssl: { enabled: false, rejectUnauthorized: true },
  sasl: null,
  schemaRegistry: null,
  connects: [],
  ksqldb: null,
  requestTimeoutMs: 30000,
  connectionTimeoutMs: 10000,
});

type TabId = 'general' | 'security' | 'integrations';

export function ClusterForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ClusterConfig | null;
  onClose: () => void;
  onSaved: (cluster: ClusterConfig) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('general');
  const [draft, setDraft] = useState<Partial<ClusterConfig>>(() =>
    initial ? JSON.parse(JSON.stringify(initial)) : emptyCluster(),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const patch = (values: Partial<ClusterConfig>) => setDraft((d) => ({ ...d, ...values }));

  const loadPem = async (target: 'ca' | 'cert' | 'key') => {
    const result = await api.openFile([{ name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'key', 'txt'] }]);
    if (result.opened && result.contents) {
      patch({ ssl: { ...(draft.ssl ?? { enabled: true, rejectUnauthorized: true }), [target]: result.contents } });
    }
  };

  const save = async (): Promise<ClusterConfig | null> => {
    if (!draft.name?.trim()) {
      toast.error('Give the cluster a name');
      setTab('general');
      return null;
    }
    if (draft.kind === 'rabbitmq') {
      if (!draft.rabbit?.url?.trim()) {
        toast.error('The management API URL is required');
        setTab('general');
        return null;
      }
    } else if (!draft.bootstrapServers?.trim()) {
      toast.error('Bootstrap servers are required');
      setTab('general');
      return null;
    }
    const saved = await api.saveCluster(draft);
    setDraft(saved);
    return saved;
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await save();
      if (saved) {
        toast.success(`Saved ${saved.name}`);
        onSaved(saved);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const saved = await save();
      if (!saved) return;
      const result = (await api.testCluster(saved.id)) as Record<string, unknown>;
      toast.success(
        saved.kind === 'rabbitmq'
          ? `Connected — RabbitMQ ${result.version} on ${result.cluster}`
          : `Connected — ${result.brokers} broker(s), cluster id ${result.clusterId}`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  const isRabbit = draft.kind === 'rabbitmq';
  const rabbit = draft.rabbit ?? { url: 'http://localhost:15672', username: 'guest', password: 'guest', vhost: '/' };
  const ssl = draft.ssl ?? { enabled: false, rejectUnauthorized: true };
  const connects = draft.connects ?? [];

  const updateConnect = (index: number, values: Partial<KafkaConnectConfig>) =>
    patch({ connects: connects.map((c, i) => (i === index ? { ...c, ...values } : c)) });

  return (
    <Modal
      wide
      title={initial ? `Edit ${initial.name}` : 'Add cluster'}
      onClose={onClose}
      footer={
        <>
          <Button className="left" onClick={onTest} loading={testing}>
            <Icon.Zap width={14} />
            Test connection
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onSave} loading={saving}>
            {initial ? 'Save changes' : 'Add cluster'}
          </Button>
        </>
      }
    >
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={
          isRabbit
            ? [{ id: 'general' as TabId, label: 'General' }]
            : [
                { id: 'general' as TabId, label: 'General' },
                { id: 'security' as TabId, label: 'Security' },
                { id: 'integrations' as TabId, label: 'Integrations' },
              ]
        }
      />

      {tab === 'general' && (
        <>
          <Field label="Broker" hint={isRabbit ? 'RabbitMQ is managed through its HTTP management plugin.' : 'Apache Kafka and API-compatible brokers (Redpanda, MSK, Confluent).'}>
            <Segmented<BrokerKind>
              value={draft.kind ?? 'kafka'}
              onChange={(kind) =>
                patch({
                  kind,
                  rabbit:
                    kind === 'rabbitmq'
                      ? (draft.rabbit ?? { url: 'http://localhost:15672', username: 'guest', password: 'guest', vhost: '/' })
                      : draft.rabbit,
                })
              }
              options={[
                { value: 'kafka', label: 'Apache Kafka' },
                { value: 'rabbitmq', label: 'RabbitMQ' },
              ]}
            />
          </Field>

          <div className="field-row">
            <Field label="Name">
              <Input
                value={draft.name ?? ''}
                autoFocus
                placeholder="Production EU"
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            {!isRabbit && (
              <Field label="Client id" hint="Sent to the broker as client.id">
                <Input value={draft.clientId ?? ''} onChange={(e) => patch({ clientId: e.target.value })} />
              </Field>
            )}
          </div>

          {isRabbit ? (
            <>
              <Field label="Management API URL" hint="The management plugin, usually port 15672">
                <Input
                  className="mono"
                  value={rabbit.url}
                  placeholder="http://localhost:15672"
                  onChange={(e) => patch({ rabbit: { ...rabbit, url: e.target.value } })}
                />
              </Field>
              <div className="field-row">
                <Field label="Username">
                  <Input value={rabbit.username} onChange={(e) => patch({ rabbit: { ...rabbit, username: e.target.value } })} />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    value={rabbit.password}
                    onChange={(e) => patch({ rabbit: { ...rabbit, password: e.target.value } })}
                  />
                </Field>
                <Field label="Virtual host">
                  <Input
                    className="mono"
                    value={rabbit.vhost}
                    placeholder="/"
                    onChange={(e) => patch({ rabbit: { ...rabbit, vhost: e.target.value } })}
                  />
                </Field>
              </div>
            </>
          ) : (
            <Field label="Bootstrap servers" hint="Comma separated host:port list">
              <Input
                className="mono"
                value={draft.bootstrapServers ?? ''}
                placeholder="broker-1:9092,broker-2:9092"
                onChange={(e) => patch({ bootstrapServers: e.target.value })}
              />
            </Field>
          )}

          <Field label="Colour">
            <div className="chip-list">
              {COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => patch({ color })}
                  aria-label={color}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    background: color,
                    border: draft.color === color ? '2px solid var(--text)' : '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </div>
          </Field>

          {!isRabbit && (
          <div className="field-row">
            <Field label="Request timeout (ms)">
              <Input
                type="number"
                value={draft.requestTimeoutMs ?? 30000}
                onChange={(e) => patch({ requestTimeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Connection timeout (ms)">
              <Input
                type="number"
                value={draft.connectionTimeoutMs ?? 10000}
                onChange={(e) => patch({ connectionTimeoutMs: Number(e.target.value) })}
              />
            </Field>
          </div>
          )}

          <Field>
            <Checkbox
              checked={Boolean(draft.readonly)}
              onChange={(readonly) => patch({ readonly })}
              label="Read-only — block produce, create, delete and config changes"
            />
          </Field>
        </>
      )}

      {tab === 'security' && (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 10 }}>SASL</h3>
          <Field>
            <Checkbox
              checked={Boolean(draft.sasl)}
              onChange={(enabled) =>
                patch({ sasl: enabled ? { mechanism: 'plain', username: '', password: '' } : null })
              }
              label="Authenticate with SASL"
            />
          </Field>
          {draft.sasl && (
            <div className="field-row">
              <Field label="Mechanism">
                <Select
                  value={draft.sasl.mechanism}
                  onChange={(e) => patch({ sasl: { ...draft.sasl!, mechanism: e.target.value as SaslMechanism } })}
                >
                  <option value="plain">PLAIN</option>
                  <option value="scram-sha-256">SCRAM-SHA-256</option>
                  <option value="scram-sha-512">SCRAM-SHA-512</option>
                </Select>
              </Field>
              <Field label="Username">
                <Input
                  value={draft.sasl.username}
                  onChange={(e) => patch({ sasl: { ...draft.sasl!, username: e.target.value } })}
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={draft.sasl.password}
                  onChange={(e) => patch({ sasl: { ...draft.sasl!, password: e.target.value } })}
                />
              </Field>
            </div>
          )}

          <h3 style={{ fontSize: 13, margin: '18px 0 10px' }}>TLS</h3>
          <Field>
            <Checkbox
              checked={ssl.enabled}
              onChange={(enabled) => patch({ ssl: { ...ssl, enabled } })}
              label="Connect over TLS"
            />
          </Field>
          {ssl.enabled && (
            <>
              <Field>
                <Checkbox
                  checked={ssl.rejectUnauthorized}
                  onChange={(rejectUnauthorized) => patch({ ssl: { ...ssl, rejectUnauthorized } })}
                  label="Verify server certificate"
                />
              </Field>
              {(['ca', 'cert', 'key'] as const).map((slot) => (
                <Field
                  key={slot}
                  label={slot === 'ca' ? 'CA certificate (PEM)' : slot === 'cert' ? 'Client certificate (PEM)' : 'Client key (PEM)'}
                  hint={
                    <Button size="sm" variant="ghost" onClick={() => void loadPem(slot)}>
                      <Icon.Upload width={13} /> Load from file
                    </Button>
                  }
                >
                  <Textarea
                    rows={4}
                    value={ssl[slot] ?? ''}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    onChange={(e) => patch({ ssl: { ...ssl, [slot]: e.target.value } })}
                  />
                </Field>
              ))}
              <Field label="Key passphrase">
                <Input
                  type="password"
                  value={ssl.passphrase ?? ''}
                  onChange={(e) => patch({ ssl: { ...ssl, passphrase: e.target.value } })}
                />
              </Field>
            </>
          )}
        </>
      )}

      {tab === 'integrations' && (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 10 }}>Schema Registry</h3>
          <div className="field-row">
            <Field label="URL">
              <Input
                className="mono"
                placeholder="http://localhost:8081"
                value={draft.schemaRegistry?.url ?? ''}
                onChange={(e) =>
                  patch({ schemaRegistry: e.target.value ? { ...(draft.schemaRegistry ?? {}), url: e.target.value } : null })
                }
              />
            </Field>
            <Field label="Username">
              <Input
                value={draft.schemaRegistry?.username ?? ''}
                disabled={!draft.schemaRegistry?.url}
                onChange={(e) =>
                  patch({ schemaRegistry: { ...(draft.schemaRegistry ?? { url: '' }), username: e.target.value } })
                }
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={draft.schemaRegistry?.password ?? ''}
                disabled={!draft.schemaRegistry?.url}
                onChange={(e) =>
                  patch({ schemaRegistry: { ...(draft.schemaRegistry ?? { url: '' }), password: e.target.value } })
                }
              />
            </Field>
          </div>

          <h3 style={{ fontSize: 13, margin: '18px 0 10px' }}>ksqlDB</h3>
          <div className="field-row">
            <Field label="URL">
              <Input
                className="mono"
                placeholder="http://localhost:8088"
                value={draft.ksqldb?.url ?? ''}
                onChange={(e) => patch({ ksqldb: e.target.value ? { ...(draft.ksqldb ?? {}), url: e.target.value } : null })}
              />
            </Field>
            <Field label="Username">
              <Input
                value={draft.ksqldb?.username ?? ''}
                disabled={!draft.ksqldb?.url}
                onChange={(e) => patch({ ksqldb: { ...(draft.ksqldb ?? { url: '' }), username: e.target.value } })}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={draft.ksqldb?.password ?? ''}
                disabled={!draft.ksqldb?.url}
                onChange={(e) => patch({ ksqldb: { ...(draft.ksqldb ?? { url: '' }), password: e.target.value } })}
              />
            </Field>
          </div>

          <h3 style={{ fontSize: 13, margin: '18px 0 10px' }}>Kafka Connect</h3>
          {connects.map((connect, index) => (
            <div key={connect.id} className="field-row" style={{ alignItems: 'end' }}>
              <Field label="Name">
                <Input value={connect.name} onChange={(e) => updateConnect(index, { name: e.target.value })} />
              </Field>
              <Field label="URL">
                <Input
                  className="mono"
                  value={connect.url}
                  placeholder="http://localhost:8083"
                  onChange={(e) => updateConnect(index, { url: e.target.value })}
                />
              </Field>
              <Field label="Username">
                <Input value={connect.username ?? ''} onChange={(e) => updateConnect(index, { username: e.target.value })} />
              </Field>
              <Field label="Password">
                <div style={{ display: 'flex', gap: 6 }}>
                  <Input
                    type="password"
                    value={connect.password ?? ''}
                    onChange={(e) => updateConnect(index, { password: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    iconOnly
                    title="Remove"
                    onClick={() => patch({ connects: connects.filter((_, i) => i !== index) })}
                  >
                    <Icon.Trash width={14} />
                  </Button>
                </div>
              </Field>
            </div>
          ))}
          <Button
            size="sm"
            onClick={() =>
              patch({
                connects: [
                  ...connects,
                  { id: crypto.randomUUID(), name: `connect-${connects.length + 1}`, url: 'http://localhost:8083' },
                ],
              })
            }
          >
            <Icon.Plus width={14} /> Add Connect cluster
          </Button>
        </>
      )}
    </Modal>
  );
}
