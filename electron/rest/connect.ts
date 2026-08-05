import type { ConnectorDetail, ConnectorSummary } from '../../shared/types';
import { clusterFor } from '../kafka/pool';
import { restRequest, type RestTarget } from './http';

function target(clusterId: string, connectId: string): RestTarget {
  const connect = clusterFor(clusterId).connects?.find((c) => c.id === connectId || c.name === connectId);
  if (!connect) throw new Error(`Kafka Connect cluster ${connectId} is not configured`);
  return { url: connect.url, username: connect.username, password: connect.password };
}

const call = <T>(clusterId: string, connectId: string, p: string, init?: Parameters<typeof restRequest>[2]) =>
  restRequest<T>(target(clusterId, connectId), p, init);

interface ExpandedConnector {
  info?: { name: string; type?: string; config?: Record<string, string>; tasks?: { connector: string; task: number }[] };
  status?: {
    name: string;
    type: string;
    connector: { state: string; worker_id: string };
    tasks: { id: number; state: string; worker_id: string; trace?: string }[];
  };
}

function toSummary(connectName: string, name: string, entry: ExpandedConnector): ConnectorSummary {
  const config = entry.info?.config ?? {};
  const topics = (config['topics'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    connect: connectName,
    name,
    type: entry.status?.type ?? entry.info?.type ?? 'unknown',
    state: entry.status?.connector.state ?? 'UNKNOWN',
    workerId: entry.status?.connector.worker_id ?? '',
    connectorClass: config['connector.class'] ?? '',
    tasks: (entry.status?.tasks ?? []).map((t) => ({ id: t.id, state: t.state, workerId: t.worker_id, trace: t.trace })),
    topics,
  };
}

export async function listConnectors(clusterId: string): Promise<ConnectorSummary[]> {
  const connects = clusterFor(clusterId).connects ?? [];
  const results = await Promise.all(
    connects.map(async (connect) => {
      try {
        const expanded = await call<Record<string, ExpandedConnector>>(
          clusterId,
          connect.id,
          '/connectors?expand=info&expand=status',
        );
        return Object.entries(expanded).map(([name, entry]) => toSummary(connect.name, name, entry));
      } catch (err) {
        return [
          {
            connect: connect.name,
            name: `— ${(err as Error).message}`,
            type: 'error',
            state: 'UNREACHABLE',
            workerId: '',
            connectorClass: '',
            tasks: [],
            topics: [],
          } satisfies ConnectorSummary,
        ];
      }
    }),
  );
  return results.flat();
}

export async function getConnector(clusterId: string, connectId: string, name: string): Promise<ConnectorDetail> {
  const [info, status] = await Promise.all([
    call<{ name: string; type: string; config: Record<string, string> }>(
      clusterId,
      connectId,
      `/connectors/${encodeURIComponent(name)}`,
    ),
    call<ExpandedConnector['status']>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}/status`),
  ]);
  const summary = toSummary(connectId, name, { info, status });
  return { ...summary, config: info.config };
}

export const connectorPlugins = (clusterId: string, connectId: string) =>
  call<{ class: string; type: string; version: string }[]>(clusterId, connectId, '/connector-plugins');

export const createConnector = (clusterId: string, connectId: string, name: string, config: Record<string, string>) =>
  call<unknown>(clusterId, connectId, '/connectors', { method: 'POST', body: { name, config } });

export const updateConnectorConfig = (
  clusterId: string,
  connectId: string,
  name: string,
  config: Record<string, string>,
) => call<unknown>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}/config`, { method: 'PUT', body: config });

export const deleteConnector = (clusterId: string, connectId: string, name: string) =>
  call<unknown>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const pauseConnector = (clusterId: string, connectId: string, name: string) =>
  call<unknown>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}/pause`, { method: 'PUT' });

export const resumeConnector = (clusterId: string, connectId: string, name: string) =>
  call<unknown>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}/resume`, { method: 'PUT' });

export const restartConnector = (clusterId: string, connectId: string, name: string) =>
  call<unknown>(
    clusterId,
    connectId,
    `/connectors/${encodeURIComponent(name)}/restart?includeTasks=true&onlyFailed=false`,
    { method: 'POST' },
  );

export const restartTask = (clusterId: string, connectId: string, name: string, taskId: number) =>
  call<unknown>(clusterId, connectId, `/connectors/${encodeURIComponent(name)}/tasks/${taskId}/restart`, {
    method: 'POST',
  });
