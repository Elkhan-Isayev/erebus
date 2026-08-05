import type { SchemaVersion } from '../../shared/types';
import { clusterFor } from '../kafka/pool';
import { restRequest, type RestTarget } from './http';

const SR_ACCEPT = 'application/vnd.schemaregistry.v1+json, application/json';

export function registryTarget(clusterId: string): RestTarget {
  const sr = clusterFor(clusterId).schemaRegistry;
  if (!sr?.url) throw new Error('Schema Registry is not configured for this cluster');
  return { url: sr.url, username: sr.username, password: sr.password };
}

export function hasRegistry(clusterId: string): boolean {
  try {
    return Boolean(clusterFor(clusterId).schemaRegistry?.url);
  } catch {
    return false;
  }
}

const call = <T>(clusterId: string, p: string, init?: Parameters<typeof restRequest>[2]) =>
  restRequest<T>(registryTarget(clusterId), p, { accept: SR_ACCEPT, ...init });

export const listSubjects = (clusterId: string) => call<string[]>(clusterId, '/subjects');

export const listVersions = (clusterId: string, subject: string) =>
  call<number[]>(clusterId, `/subjects/${encodeURIComponent(subject)}/versions`);

export async function getVersion(clusterId: string, subject: string, version: number | 'latest'): Promise<SchemaVersion> {
  const raw = await call<{ subject: string; version: number; id: number; schema: string; schemaType?: string }>(
    clusterId,
    `/subjects/${encodeURIComponent(subject)}/versions/${version}`,
  );
  let compatibility: string | undefined;
  try {
    const cfg = await call<{ compatibilityLevel?: string }>(clusterId, `/config/${encodeURIComponent(subject)}`);
    compatibility = cfg?.compatibilityLevel;
  } catch {
    try {
      const global = await call<{ compatibilityLevel?: string }>(clusterId, '/config');
      compatibility = global?.compatibilityLevel ? `${global.compatibilityLevel} (global)` : undefined;
    } catch {
      compatibility = undefined;
    }
  }
  return {
    subject: raw.subject,
    version: raw.version,
    id: raw.id,
    schemaType: (raw.schemaType as SchemaVersion['schemaType']) ?? 'AVRO',
    schema: raw.schema,
    compatibility,
  };
}

export const registerSchema = (
  clusterId: string,
  subject: string,
  schema: string,
  schemaType: SchemaVersion['schemaType'],
) =>
  call<{ id: number }>(clusterId, `/subjects/${encodeURIComponent(subject)}/versions`, {
    method: 'POST',
    contentType: 'application/vnd.schemaregistry.v1+json',
    body: { schema, schemaType },
  });

export const deleteSubject = (clusterId: string, subject: string, permanent = false) =>
  call<number[]>(clusterId, `/subjects/${encodeURIComponent(subject)}${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
  });

export const deleteVersion = (clusterId: string, subject: string, version: number) =>
  call<number>(clusterId, `/subjects/${encodeURIComponent(subject)}/versions/${version}`, { method: 'DELETE' });

export const setCompatibility = (clusterId: string, subject: string, level: string) =>
  call<{ compatibility: string }>(clusterId, `/config/${encodeURIComponent(subject)}`, {
    method: 'PUT',
    body: { compatibility: level },
  });

export const checkCompatibility = (clusterId: string, subject: string, schema: string, schemaType: string) =>
  call<{ is_compatible: boolean }>(
    clusterId,
    `/compatibility/subjects/${encodeURIComponent(subject)}/versions/latest?verbose=true`,
    { method: 'POST', body: { schema, schemaType } },
  );

/* ------------------------------------------------------------ schema by id */

interface CachedSchema {
  schema: string;
  schemaType: string;
}

const byId = new Map<string, Promise<CachedSchema>>();

export function schemaById(clusterId: string, id: number): Promise<CachedSchema> {
  const key = `${clusterId}:${id}`;
  let hit = byId.get(key);
  if (!hit) {
    hit = call<{ schema: string; schemaType?: string }>(clusterId, `/schemas/ids/${id}`)
      .then((r) => ({ schema: r.schema, schemaType: r.schemaType ?? 'AVRO' }))
      .catch((err) => {
        byId.delete(key);
        throw err;
      });
    byId.set(key, hit);
  }
  return hit;
}

export function clearSchemaCache(): void {
  byId.clear();
}
