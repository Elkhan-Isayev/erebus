import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icons';
import { Button, Checkbox, Field, Input, KeyValue, PageHead, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { useAppState } from '@/app/AppState';
import { useToast } from '@/lib/toast';
import type { TerminalProfile, ThemeMode } from '@shared/types';

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

export function SettingsPage() {
  const { settings, saveSettings, info } = useAppState();

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
