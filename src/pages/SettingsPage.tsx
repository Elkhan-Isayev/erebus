import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icons';
import { Button, Checkbox, ConfirmDialog, Field, Input, KeyValue, Modal, PageHead, Segmented, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useAppState } from '@/app/AppState';
import { useToast } from '@/lib/toast';
import type { AvroSchemaEntry, TerminalProfile, ThemeMode } from '@shared/types';

/** Saved commands — typically `kubectl port-forward` — with optional start-up on launch. */
function TerminalProfiles() {
  const toast = useToast();
  const { settings, saveSettings } = useAppState();
  const [profiles, setProfiles] = useState<TerminalProfile[]>(settings.terminals ?? []);

  useEffect(() => setProfiles(settings.terminals ?? []), [settings.terminals]);

  const persist = async (next: TerminalProfile[]) => {
    setProfiles(next);
    try {
      await saveSettings({ terminals: next });
    } catch (err) {
      toast.error(err);
    }
  };

  const update = (id: string, patch: Partial<TerminalProfile>) =>
    void persist(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <h3>Terminal profiles</h3>
        <div className="actions">
          <Button
            size="sm"
            onClick={() =>
              void persist([
                ...profiles,
                {
                  id: crypto.randomUUID(),
                  name: `profile-${profiles.length + 1}`,
                  command: 'kubectl port-forward svc/kafka 9092:9092',
                  autoStart: false,
                },
              ])
            }
          >
            <Icon.Plus width={13} /> Add profile
          </Button>
        </div>
      </div>
      <div className="card-pad">
        <p className="subtle" style={{ marginTop: 0 }}>
          Profiles open in a terminal tab from the panel. Auto-start ones run as soon as Erebus launches — handy for
          port-forwards you always need.
        </p>
        {profiles.length === 0 && <div className="subtle">No profiles yet.</div>}
        {profiles.map((profile) => (
          <div key={profile.id} className="profile-row">
            <Input value={profile.name} placeholder="Name" onChange={(e) => update(profile.id, { name: e.target.value })} />
            <Input
              className="mono"
              value={profile.command}
              placeholder="kubectl port-forward svc/kafka 9092:9092"
              onChange={(e) => update(profile.id, { command: e.target.value })}
            />
            <Checkbox
              checked={profile.autoStart}
              onChange={(autoStart) => update(profile.id, { autoStart })}
              label="auto-start"
            />
            <Button
              variant="ghost"
              iconOnly
              title="Delete profile"
              onClick={() => void persist(profiles.filter((p) => p.id !== profile.id))}
            >
              <Icon.Trash width={14} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Local Avro schemas — the "Avro plugin" for clusters without a Schema Registry. */
function AvroSchemas() {
  const toast = useToast();
  const { settings, reloadSettings } = useAppState();
  const schemas = settings.avroSchemas ?? [];
  const [editing, setEditing] = useState<AvroSchemaEntry | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const blank = (): AvroSchemaEntry => ({
    id: '',
    name: '',
    schema: JSON.stringify(
      { type: 'record', name: 'Order', fields: [{ name: 'id', type: 'long' }, { name: 'status', type: 'string' }] },
      null,
      2,
    ),
  });

  const save = async (entry: AvroSchemaEntry) => {
    if (!entry.name.trim()) return toast.error('Give the schema a name');
    try {
      await api.saveAvroSchema({ id: entry.id || undefined, name: entry.name.trim(), schema: entry.schema });
      await reloadSettings();
      toast.success(`Saved ${entry.name}`);
      setEditing(null);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <h3>Avro schemas</h3>
        <div className="actions">
          <Button size="sm" onClick={() => setEditing(blank())}>
            <Icon.Plus width={13} /> Add schema
          </Button>
        </div>
      </div>
      <div className="card-pad">
        <p className="subtle" style={{ marginTop: 0 }}>
          Paste an <code>.avsc</code> document and it appears as a deserializer in the message browser and in Produce —
          for brokers with no Schema Registry, or one you cannot reach. Payloads carrying a Confluent header are handled
          too: the five leading bytes are skipped.
        </p>
        {schemas.length === 0 && <div className="subtle">No schemas yet.</div>}
        {schemas.map((entry) => (
          <div key={entry.id} className="profile-row" style={{ gridTemplateColumns: '1fr 2fr auto auto' }}>
            <span className="mono">{entry.name}</span>
            <span className="subtle mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.schema.replace(/\s+/g, ' ').slice(0, 80)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(entry)}>
              <Icon.Edit width={13} /> Edit
            </Button>
            <Button variant="ghost" iconOnly title="Delete schema" onClick={() => setDeleting(entry.id)}>
              <Icon.Trash width={14} />
            </Button>
          </div>
        ))}
      </div>

      {editing && (
        <Modal
          wide
          title={editing.id ? `Edit ${editing.name}` : 'Add Avro schema'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button
                className="left"
                onClick={async () => {
                  const result = await api.validateAvroSchema(editing.schema);
                  if (result.valid) toast.success('Schema parses');
                  else toast.error(result.error ?? 'Invalid schema');
                }}
              >
                Validate
              </Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void save(editing)}>
                Save schema
              </Button>
            </>
          }
        >
          <Field label="Name" hint="Shown in the serde dropdowns">
            <Input
              className="mono"
              autoFocus
              value={editing.name}
              placeholder="orders.v1-value"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <Field label="Schema (.avsc)">
            <textarea
              className="textarea"
              rows={16}
              spellCheck={false}
              value={editing.schema}
              onChange={(e) => setEditing({ ...editing, schema: e.target.value })}
            />
          </Field>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title="Delete this schema?"
          message="Messages you were reading with it fall back to the raw payload."
          confirmLabel="Delete schema"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteAvroSchema(deleting);
            await reloadSettings();
            toast.success('Schema deleted');
          }}
        />
      )}
    </div>
  );
}

export function SettingsPage() {
  const { settings, saveSettings, info, clusters } = useAppState();

  return (
    <>
      <PageHead title="Settings" subtitle="Preferences are stored locally alongside your cluster configuration." />

      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>Appearance</h3>
          </div>
          <div className="card-pad">
            <Field label="Theme" hint="System follows your OS light/dark setting.">
              <Segmented<ThemeMode>
                value={settings.theme}
                onChange={(theme) => void saveSettings({ theme })}
                options={[
                  { value: 'light', label: <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon.Sun width={13} /> Light</span> },
                  { value: 'dark', label: <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon.Moon width={13} /> Dark</span> },
                  { value: 'system', label: <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon.Monitor width={13} /> System</span> },
                ]}
              />
            </Field>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>On launch</h3>
          </div>
          <div className="card-pad">
            <Field label="Open this cluster" hint="Erebus lands here every time it starts.">
              <Select
                value={settings.defaultClusterId ?? ''}
                onChange={(e) => void saveSettings({ defaultClusterId: e.target.value || null })}
              >
                <option value="">First cluster in the list</option>
                {clusters.map((cluster) => (
                  <option key={cluster.id} value={cluster.id}>
                    {cluster.name} ({cluster.kind === 'rabbitmq' ? 'RabbitMQ' : 'Kafka'})
                  </option>
                ))}
              </Select>
            </Field>
            <p className="subtle" style={{ margin: 0 }}>
              Terminal profiles marked <b>auto-start</b> below run at the same moment — port-forwards are up before the
              first screen is painted.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Message browser</h3>
          </div>
          <div className="card-pad">
            <Field label="Default fetch limit" hint="How many messages a fetch pulls before it stops.">
              <Input
                type="number"
                min={1}
                max={10000}
                value={settings.defaultMessageLimit}
                onChange={(e) => void saveSettings({ defaultMessageLimit: Math.max(1, Number(e.target.value)) })}
              />
            </Field>
            <Field label="Live tail buffer" hint="Messages kept in memory while tailing.">
              <Input
                type="number"
                min={50}
                max={20000}
                value={settings.liveTailBuffer}
                onChange={(e) => void saveSettings({ liveTailBuffer: Math.max(50, Number(e.target.value)) })}
              />
            </Field>
          </div>
        </div>
      </div>

      <TerminalProfiles />

      <AvroSchemas />

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h3>About</h3>
          <div className="actions">
            <Button size="sm" variant="ghost" onClick={() => void api.openExternal('https://github.com/Elkhan-Isayev/erebus')}>
              <Icon.External width={13} /> GitHub
            </Button>
          </div>
        </div>
        <div className="card-pad">
          <KeyValue
            items={[
              ['Version', info?.version ?? '—'],
              ['Platform', info ? `${info.platform} ${info.arch}` : '—'],
              ['Electron', info?.electron ?? '—'],
              ['Node', info?.node ?? '—'],
              ['Config file', <span className="mono">{info?.configPath ?? '—'}</span>],
            ]}
          />
        </div>
      </div>
    </>
  );
}
