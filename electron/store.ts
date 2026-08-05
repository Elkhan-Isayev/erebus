import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, ClusterConfig, PersistedState } from '../shared/types';

const FILE = () => path.join(app.getPath('userData'), 'erebus.config.json');
const ENC_PREFIX = 'enc:v1:';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultMessageLimit: 100,
  showInternalTopics: false,
  liveTailBuffer: 500,
  terminals: [],
  avroSchemas: [],
  defaultClusterId: null,
};

/** Secrets are encrypted with the OS keychain when it is available. */
function encrypt(value: string | undefined | null): string | undefined {
  if (!value) return value ?? undefined;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
    }
  } catch {
    /* fall through to plaintext */
  }
  return value;
}

function decrypt(value: string | undefined | null): string | undefined {
  if (!value) return value ?? undefined;
  if (!value.startsWith(ENC_PREFIX)) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

const SECRET_MAPPERS = (fn: (v?: string | null) => string | undefined) => (c: ClusterConfig): ClusterConfig => ({
  ...c,
  sasl: c.sasl ? { ...c.sasl, password: fn(c.sasl.password) ?? '' } : c.sasl,
  ssl: { ...c.ssl, key: fn(c.ssl?.key), passphrase: fn(c.ssl?.passphrase) },
  schemaRegistry: c.schemaRegistry ? { ...c.schemaRegistry, password: fn(c.schemaRegistry.password) } : c.schemaRegistry,
  rabbit: c.rabbit ? { ...c.rabbit, password: fn(c.rabbit.password) ?? '' } : c.rabbit,
  ksqldb: c.ksqldb ? { ...c.ksqldb, password: fn(c.ksqldb.password) } : c.ksqldb,
  connects: (c.connects ?? []).map((k) => ({ ...k, password: fn(k.password) })),
});

let cache: PersistedState | null = null;

function normalizeCluster(raw: Partial<ClusterConfig>): ClusterConfig {
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: raw.name ?? 'Unnamed cluster',
    kind: raw.kind ?? 'kafka',
    color: raw.color,
    bootstrapServers: raw.bootstrapServers ?? 'localhost:9092',
    rabbit: raw.rabbit
      ? {
          url: raw.rabbit.url ?? 'http://localhost:15672',
          username: raw.rabbit.username ?? 'guest',
          password: raw.rabbit.password ?? '',
          vhost: raw.rabbit.vhost || '/',
        }
      : null,
    clientId: raw.clientId || 'erebus',
    readonly: raw.readonly ?? false,
    ssl: {
      enabled: raw.ssl?.enabled ?? false,
      rejectUnauthorized: raw.ssl?.rejectUnauthorized ?? true,
      ca: raw.ssl?.ca,
      cert: raw.ssl?.cert,
      key: raw.ssl?.key,
      passphrase: raw.ssl?.passphrase,
    },
    sasl: raw.sasl ?? null,
    schemaRegistry: raw.schemaRegistry ?? null,
    connects: raw.connects ?? [],
    ksqldb: raw.ksqldb ?? null,
    requestTimeoutMs: raw.requestTimeoutMs ?? 30_000,
    connectionTimeoutMs: raw.connectionTimeoutMs ?? 10_000,
    createdAt: raw.createdAt ?? Date.now(),
  };
}

export function read(): PersistedState {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as PersistedState;
    cache = {
      clusters: (parsed.clusters ?? []).map(normalizeCluster).map(SECRET_MAPPERS(decrypt)),
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings ?? {}),
        terminals: parsed.settings?.terminals ?? [],
        avroSchemas: parsed.settings?.avroSchemas ?? [],
      },
    };
  } catch {
    cache = { clusters: [], settings: { ...DEFAULT_SETTINGS } };
  }
  return cache;
}

function persist(state: PersistedState) {
  cache = state;
  const onDisk: PersistedState = {
    clusters: state.clusters.map(SECRET_MAPPERS(encrypt)),
    settings: state.settings,
  };
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
}

export function listClusters(): ClusterConfig[] {
  return read().clusters;
}

export function getCluster(id: string): ClusterConfig {
  const found = read().clusters.find((c) => c.id === id);
  if (!found) throw new Error(`Cluster ${id} is not configured`);
  return found;
}

export function upsertCluster(input: Partial<ClusterConfig>): ClusterConfig {
  const state = read();
  const cluster = normalizeCluster(input);
  const idx = state.clusters.findIndex((c) => c.id === cluster.id);
  if (idx >= 0) state.clusters[idx] = { ...state.clusters[idx], ...cluster };
  else state.clusters.push(cluster);
  persist({ ...state });
  return cluster;
}

export function deleteCluster(id: string): void {
  const state = read();
  persist({ ...state, clusters: state.clusters.filter((c) => c.id !== id) });
}

export function getSettings(): AppSettings {
  return read().settings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const state = read();
  const settings = { ...state.settings, ...patch };
  persist({ ...state, settings });
  return settings;
}

export function configPath(): string {
  return FILE();
}

export function exportClusters(): string {
  // Exports without secrets so a config can be shared safely.
  const scrub = (v?: string | null) => (v ? '' : undefined);
  return JSON.stringify({ clusters: read().clusters.map(SECRET_MAPPERS(scrub)) }, null, 2);
}

export function importClusters(json: string): ClusterConfig[] {
  const parsed = JSON.parse(json) as { clusters?: Partial<ClusterConfig>[] } | Partial<ClusterConfig>[];
  const incoming = Array.isArray(parsed) ? parsed : (parsed.clusters ?? []);
  const state = read();
  const merged = [...state.clusters];
  for (const raw of incoming) {
    const cluster = normalizeCluster({ ...raw, id: raw.id ?? crypto.randomUUID() });
    const idx = merged.findIndex((c) => c.id === cluster.id);
    if (idx >= 0) merged[idx] = cluster;
    else merged.push(cluster);
  }
  persist({ ...state, clusters: merged });
  return merged;
}
