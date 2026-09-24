import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapList, parseOverrides, routeAddress, routedSocketFactory, splitAddress } from './routing';

describe('splitAddress', () => {
  it('splits host and port', () => {
    expect(splitAddress('localhost:9095')).toEqual({ host: 'localhost', port: 9095 });
  });

  it('gives a bare host the Kafka default port', () => {
    expect(splitAddress('kafka')).toEqual({ host: 'kafka', port: 9092 });
  });

  it('unwraps bracketed IPv6 so net.connect can dial it', () => {
    expect(splitAddress('[::1]:9095')).toEqual({ host: '::1', port: 9095 });
    expect(splitAddress('[::1]')).toEqual({ host: '::1', port: 9092 });
  });
});

describe('bootstrapList', () => {
  it('trims entries and drops empty ones', () => {
    expect(bootstrapList({ bootstrapServers: ' a:1 , ,b:2,' })).toEqual(['a:1', 'b:2']);
  });
});

describe('parseOverrides', () => {
  it('accepts every documented separator', () => {
    const map = parseOverrides('a:1 => x:1\nb:2 -> x:2\nc:3=x:3\nd:4   x:4');
    expect([...map]).toEqual([
      ['a:1', 'x:1'],
      ['b:2', 'x:2'],
      ['c:3', 'x:3'],
      ['d:4', 'x:4'],
    ]);
  });

  it('skips comments, blank lines and lines without a target', () => {
    const map = parseOverrides('# port-forwards\n\nkafka-0:9094 => localhost:9095  # dev\nlonely:1\n');
    expect([...map]).toEqual([['kafka-0:9094', 'localhost:9095']]);
  });

  it('matches advertised hosts case-insensitively', () => {
    expect(parseOverrides('Kafka-0.Svc:9094 => localhost:9095').get('kafka-0.svc:9094')).toBe('localhost:9095');
  });

  it('is empty for no text', () => {
    expect(parseOverrides(undefined).size).toBe(0);
  });
});

describe('routeAddress', () => {
  // The case from the field: dev on 9095 advertises localhost:9094, which preprod's port-forward owns.
  const dev = { bootstrapServers: 'localhost:9095' };

  it('leaves the advertised address alone by default', () => {
    expect(routeAddress(dev, 'localhost', 9094)).toEqual({ host: 'localhost', port: 9094 });
  });

  it('sends every broker to the first bootstrap address when asked', () => {
    const cluster = { ...dev, bootstrapServers: 'localhost:9095,localhost:9096', routeViaBootstrap: true };
    expect(routeAddress(cluster, 'localhost', 9094)).toEqual({ host: 'localhost', port: 9095 });
    expect(routeAddress(cluster, 'kafka-2.headless', 9094)).toEqual({ host: 'localhost', port: 9095 });
  });

  it('prefers an explicit override to routeViaBootstrap', () => {
    const cluster = { ...dev, routeViaBootstrap: true, brokerOverrides: 'kafka-1:9094 => localhost:9096' };
    expect(routeAddress(cluster, 'kafka-1', 9094)).toEqual({ host: 'localhost', port: 9096 });
    expect(routeAddress(cluster, 'kafka-0', 9094)).toEqual({ host: 'localhost', port: 9095 });
  });

  it('only rewrites the exact host:port that was overridden', () => {
    const cluster = { ...dev, brokerOverrides: 'localhost:9094 => localhost:9095' };
    expect(routeAddress(cluster, 'localhost', 9094)).toEqual({ host: 'localhost', port: 9095 });
    expect(routeAddress(cluster, 'localhost', 9093)).toEqual({ host: 'localhost', port: 9093 });
  });
});

describe('routedSocketFactory', () => {
  const servers: net.Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  /** A TCP server that resolves with its port and records whether anyone connected. */
  async function listener() {
    const server = net.createServer((socket) => socket.end());
    servers.push(server);
    const hits: number[] = [];
    server.on('connection', () => hits.push(Date.now()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as net.AddressInfo).port, hits };
  }

  const dial = (factory: ReturnType<typeof routedSocketFactory>, host: string, port: number) =>
    new Promise<void>((resolve, reject) => {
      const socket = factory({ host, port, ssl: undefined as never, onConnect: () => (socket.destroy(), resolve()) });
      socket.on('error', reject);
    });

  it('dials the override target instead of the advertised address', async () => {
    const advertised = await listener();
    const actual = await listener();
    const factory = routedSocketFactory({
      bootstrapServers: `127.0.0.1:${actual.port}`,
      brokerOverrides: `127.0.0.1:${advertised.port} => 127.0.0.1:${actual.port}`,
    });

    await dial(factory, '127.0.0.1', advertised.port);

    // The client can see its connect before the server sees the connection.
    await vi.waitFor(() => expect(actual.hits).toHaveLength(1));
    expect(advertised.hits).toHaveLength(0);
  });

  it('pins every connection to one address, whatever broker is asked for', async () => {
    const pinned = await listener();
    const other = await listener();
    const factory = routedSocketFactory({ bootstrapServers: `127.0.0.1:${other.port}` }, { host: '127.0.0.1', port: pinned.port });

    await dial(factory, '127.0.0.1', other.port);
    await dial(factory, 'kafka-7.nowhere', 9094);

    await vi.waitFor(() => expect(pinned.hits).toHaveLength(2));
    expect(other.hits).toHaveLength(0);
  });
});
