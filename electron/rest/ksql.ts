import type { KsqlResponse } from '../../shared/types';
import { clusterFor } from '../kafka/pool';
import { restRequest, type RestTarget } from './http';

function target(clusterId: string): RestTarget {
  const ksql = clusterFor(clusterId).ksqldb;
  if (!ksql?.url) throw new Error('ksqlDB is not configured for this cluster');
  return { url: ksql.url, username: ksql.username, password: ksql.password };
}

const KSQL_ACCEPT = 'application/vnd.ksql.v1+json, application/json';

/** Statements (SHOW/CREATE/DROP/TERMINATE) go to /ksql; SELECTs go to /query. */
export async function execute(clusterId: string, sql: string): Promise<KsqlResponse> {
  const statement = sql.trim().replace(/;?\s*$/, ';');
  const isQuery = /^\s*select\b/i.test(statement);
  const t = target(clusterId);

  if (!isQuery) {
    const raw = await restRequest<unknown[]>(t, '/ksql', {
      method: 'POST',
      accept: KSQL_ACCEPT,
      contentType: 'application/vnd.ksql.v1+json',
      body: { ksql: statement, streamsProperties: {} },
      timeoutMs: 60_000,
    });
    return tabulateStatement(raw);
  }

  const raw = await restRequest<unknown>(t, '/query', {
    method: 'POST',
    accept: KSQL_ACCEPT,
    contentType: 'application/vnd.ksql.v1+json',
    body: { ksql: statement, streamsProperties: { 'ksql.streams.auto.offset.reset': 'earliest' } },
    timeoutMs: 60_000,
  });
  return tabulateQuery(raw);
}

function tabulateQuery(raw: unknown): KsqlResponse {
  const rows: unknown[][] = [];
  let columns: string[] = [];
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    const e = entry as { header?: { schema?: string }; row?: { columns?: unknown[] } };
    if (e?.header?.schema) {
      columns = e.header.schema.split(/,(?![^<]*>)/).map((c) => c.trim().split(/\s+/)[0].replace(/^`|`$/g, ''));
    }
    if (e?.row?.columns) rows.push(e.row.columns);
  }
  if (columns.length === 0 && rows.length > 0) columns = rows[0].map((_, i) => `col${i + 1}`);
  return { columns, rows, raw };
}

function tabulateStatement(raw: unknown[]): KsqlResponse {
  const first = (raw ?? [])[0] as Record<string, unknown> | undefined;
  if (!first) return { columns: [], rows: [], raw };

  const collectionKeys = ['streams', 'tables', 'topics', 'queries', 'properties', 'functions', 'sourceDescription'];
  for (const key of collectionKeys) {
    const value = first[key];
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      const columns = [...new Set(value.flatMap((v) => Object.keys(v as object)))];
      return {
        columns,
        rows: value.map((v) => columns.map((c) => (v as Record<string, unknown>)[c])),
        raw,
      };
    }
  }
  const columns = Object.keys(first);
  return { columns, rows: [columns.map((c) => first[c])], raw };
}

export const listStreams = (clusterId: string) => execute(clusterId, 'SHOW STREAMS;');
export const listTables = (clusterId: string) => execute(clusterId, 'SHOW TABLES;');
export const listQueries = (clusterId: string) => execute(clusterId, 'SHOW QUERIES;');

export async function info(clusterId: string): Promise<Record<string, unknown>> {
  return restRequest<Record<string, unknown>>(target(clusterId), '/info', { accept: KSQL_ACCEPT });
}
