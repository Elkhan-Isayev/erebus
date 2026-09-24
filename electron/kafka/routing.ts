/**
 * Where a broker connection really goes. Brokers hand out their advertised addresses, and
 * behind a port-forward those point at in-cluster names — or, worse, at a localhost port
 * some *other* port-forward already owns, so reads silently hit another cluster. Overrides
 * and routeViaBootstrap bend those addresses back to one that works.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { ISocketFactory } from 'kafkajs';
import type { ClusterConfig } from '../../shared/types';

export type Address = { host: string; port: number };
export type RoutingConfig = Pick<ClusterConfig, 'bootstrapServers' | 'brokerOverrides' | 'routeViaBootstrap'>;

const DEFAULT_PORT = 9092;

export const bootstrapList = (cluster: Pick<ClusterConfig, 'bootstrapServers'>): string[] =>
  cluster.bootstrapServers
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

/** `host:port`, `[v6]:port` or a bare host, which gets Kafka's default port. */
export function splitAddress(address: string): Address {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : DEFAULT_PORT };
  const at = address.lastIndexOf(':');
  return at < 0 ? { host: address, port: DEFAULT_PORT } : { host: address.slice(0, at), port: Number(address.slice(at + 1)) };
}

/** `advertised => actual` per line; `->`, `=` or whitespace also separate the pair, `#` starts a comment. */
export function parseOverrides(text: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [from, to] = line.split(/\s*(?:=>|->|=|\s)\s*/).filter(Boolean);
    if (from && to) map.set(from.toLowerCase(), to);
  }
  return map;
}

export function routeAddress(cluster: RoutingConfig, host: string, port: number): Address {
  const mapped = parseOverrides(cluster.brokerOverrides).get(`${host}:${port}`.toLowerCase());
  if (mapped) return splitAddress(mapped);
  if (cluster.routeViaBootstrap) {
    const [first] = bootstrapList(cluster);
    if (first) return splitAddress(first);
  }
  return { host, port };
}

/** `pinTo` sends every connection to one address, whatever broker kafkajs thinks it is dialling. */
export function routedSocketFactory(cluster: RoutingConfig, pinTo?: Address): ISocketFactory {
  return ({ host, port, ssl, onConnect }) => {
    const target = pinTo ?? routeAddress(cluster, host, port);
    const socket = ssl
      ? tls.connect(
          // The certificate still names the advertised host, so SNI and verification use it.
          { ...ssl, host: target.host, port: target.port, ...(!net.isIP(host) ? { servername: host } : {}) },
          onConnect,
        )
      : net.connect({ host: target.host, port: target.port }, onConnect);
    socket.setKeepAlive(true, 60_000);
    return socket;
  };
}
