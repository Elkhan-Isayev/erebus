import { describe, expect, it } from 'vitest';
import { inspectCluster, judgeIdentity, profileFor, writeBlockReason, type Probe, type ProbeResult } from './identity';

/**
 * A laptop with kubectl tunnels, as a table: which cluster answers at each local address.
 * Anything not in the table refuses the connection, the way a closed port does.
 */
function laptop(tunnels: Record<string, ProbeResult>): Probe {
  return async ({ host, port }) => {
    const answer = tunnels[`${host}:${port}`];
    if (!answer) throw Object.assign(new Error('Connection error: '), { cause: { code: 'ECONNREFUSED' } });
    return answer;
  };
}

const broker = (nodeId: number, address: string) => {
  const [host, port] = address.split(':');
  return { nodeId, host, port: Number(port) };
};

/** A single-broker cluster that tells clients to come back at `advertised`. */
const cluster = (clusterId: string, advertised: string): ProbeResult => ({ clusterId, brokers: [broker(1, advertised)] });

const dev = { id: 'p-dev', name: 'Dev Push30', bootstrapServers: 'localhost:9095', pinnedClusterId: 'dev-id' };
const preprod = { id: 'p-pre', name: 'Preprod Push30', bootstrapServers: 'localhost:9094', pinnedClusterId: 'preprod-id' };
const profiles = [dev, preprod];

describe('inspectCluster — routes', () => {
  it('passes a healthy port-forward: bootstrap and broker are the same cluster', async () => {
    const check = await inspectCluster(dev, profiles, laptop({ 'localhost:9095': cluster('dev-id', 'localhost:9095') }));

    expect(check.routes).toEqual([
      { nodeId: 1, advertised: 'localhost:9095', connectsTo: 'localhost:9095', reachedClusterId: 'dev-id', reachedProfile: null, ok: true },
    ]);
    expect(check.identity.status).toBe('match');
  });

  // The bug from the office: dev on 9095 advertises localhost:9094, which preprod's tunnel owns.
  it('catches a broker that advertises a port another cluster holds, and names that cluster', async () => {
    const check = await inspectCluster(
      dev,
      profiles,
      laptop({ 'localhost:9095': cluster('dev-id', 'localhost:9094'), 'localhost:9094': cluster('preprod-id', 'localhost:9094') }),
    );

    expect(check.clusterId).toBe('dev-id');
    expect(check.routes[0]).toMatchObject({ connectsTo: 'localhost:9094', reachedClusterId: 'preprod-id', reachedProfile: 'Preprod Push30', ok: false });
    // The bootstrap itself is still the right cluster; only the route is wrong.
    expect(check.identity.status).toBe('match');
  });

  it('is satisfied once every connection is routed through the bootstrap', async () => {
    const check = await inspectCluster(
      { ...dev, routeViaBootstrap: true },
      profiles,
      laptop({ 'localhost:9095': cluster('dev-id', 'localhost:9094'), 'localhost:9094': cluster('preprod-id', 'localhost:9094') }),
    );

    expect(check.routes[0]).toMatchObject({ advertised: 'localhost:9094', connectsTo: 'localhost:9095', reachedClusterId: 'dev-id', ok: true });
  });

  it('reports an advertised address that nothing answers at', async () => {
    const check = await inspectCluster(dev, profiles, laptop({ 'localhost:9095': cluster('dev-id', 'kafka-0.kafka-headless.svc:9094') }));

    expect(check.routes[0]).toMatchObject({ reachedClusterId: null, ok: false, error: 'Connection error: ECONNREFUSED' });
  });

  it('flags only the broker that leads elsewhere in a multi-broker cluster', async () => {
    const devThree: ProbeResult = { clusterId: 'dev-id', brokers: [broker(1, 'localhost:9095'), broker(2, 'localhost:9096'), broker(3, 'localhost:9094')] };
    const check = await inspectCluster(
      dev,
      profiles,
      laptop({ 'localhost:9095': devThree, 'localhost:9096': devThree, 'localhost:9094': cluster('preprod-id', 'localhost:9094') }),
    );

    expect(check.routes.map((r) => [r.nodeId, r.ok])).toEqual([[1, true], [2, true], [3, false]]);
  });

  it('fails loudly when the bootstrap itself is unreachable', async () => {
    await expect(inspectCluster(dev, profiles, laptop({}))).rejects.toThrow('Connection error');
  });
});

describe('inspectCluster — identity', () => {
  /*
   * The regression case from review: two valid clusters, endpoints swapped. Every
   * connection succeeds and every broker agrees with its bootstrap, so the route check
   * alone reports nothing. Only the pinned cluster id shows the target is wrong.
   */
  it('catches swapped endpoints where connectivity succeeds but the target is wrong', async () => {
    const swapped = laptop({
      'localhost:9095': cluster('preprod-id', 'localhost:9095'),
      'localhost:9094': cluster('dev-id', 'localhost:9094'),
    });

    const devCheck = await inspectCluster(dev, profiles, swapped);
    expect(devCheck.routes.every((r) => r.ok)).toBe(true);
    expect(devCheck.identity).toEqual({ status: 'changed', expected: 'dev-id', actual: 'preprod-id', actualProfile: 'Preprod Push30' });
    expect(writeBlockReason(devCheck.profileName, devCheck.identity)).toContain('Writes are blocked');

    const preprodCheck = await inspectCluster(preprod, profiles, swapped);
    expect(preprodCheck.routes.every((r) => r.ok)).toBe(true);
    expect(preprodCheck.identity).toEqual({ status: 'changed', expected: 'preprod-id', actual: 'dev-id', actualProfile: 'Dev Push30' });
  });

  // Same port, different day: yesterday's dev tunnel on 9094 is today's prod tunnel.
  it('catches a port that now leads to a cluster no profile knows', async () => {
    const check = await inspectCluster(
      { ...dev, bootstrapServers: 'localhost:9094' },
      profiles.filter((p) => p !== preprod),
      laptop({ 'localhost:9094': cluster('prod-id', 'localhost:9094') }),
    );

    expect(check.identity).toEqual({ status: 'changed', expected: 'dev-id', actual: 'prod-id', actualProfile: null });
  });

  it('pins a new profile to the first cluster it reaches', async () => {
    const fresh = { id: 'p-new', name: 'New', bootstrapServers: 'localhost:9097', pinnedClusterId: undefined };
    const check = await inspectCluster(fresh, [...profiles, fresh], laptop({ 'localhost:9097': cluster('new-id', 'localhost:9097') }));

    expect(check.identity).toEqual({ status: 'pinned-now', expected: null, actual: 'new-id', actualProfile: null });
    expect(writeBlockReason(check.profileName, check.identity)).toBeNull();
  });

  it('asks before pinning a new profile to a cluster another profile already owns', async () => {
    const staging = { id: 'p-stg', name: 'Staging', bootstrapServers: 'localhost:9094', pinnedClusterId: undefined };
    const check = await inspectCluster(staging, [...profiles, staging], laptop({ 'localhost:9094': cluster('preprod-id', 'localhost:9094') }));

    expect(check.identity).toEqual({ status: 'changed', expected: null, actual: 'preprod-id', actualProfile: 'Preprod Push30' });
    expect(writeBlockReason(check.profileName, check.identity)).toContain('which another profile already uses');
  });

  it('accepts two profiles for one cluster once both are pinned to it', () => {
    const readOnly = { id: 'p-ro', name: 'Preprod (read-only)', pinnedClusterId: 'preprod-id' };
    expect(judgeIdentity('preprod-id', 'preprod-id', [...profiles, readOnly], 'p-ro').status).toBe('match');
  });
});

describe('profileFor', () => {
  it('never names the profile being checked', () => {
    expect(profileFor('dev-id', profiles, 'p-dev')).toBeNull();
    expect(profileFor('dev-id', profiles, 'p-pre')).toBe('Dev Push30');
  });

  it('knows nothing about an unknown or missing id', () => {
    expect(profileFor('other-id', profiles, 'p-dev')).toBeNull();
    expect(profileFor(null, profiles, 'p-dev')).toBeNull();
  });
});

describe('writeBlockReason', () => {
  it('lets writes through unless the cluster changed', () => {
    expect(writeBlockReason('Dev', null)).toBeNull();
    expect(writeBlockReason('Dev', { status: 'match', expected: 'a', actual: 'a', actualProfile: null })).toBeNull();
    expect(writeBlockReason('Dev', { status: 'pinned-now', expected: null, actual: 'a', actualProfile: null })).toBeNull();
  });

  it('says which cluster answers and which was expected', () => {
    expect(writeBlockReason('Dev Push30', { status: 'changed', expected: 'dev-id', actual: 'preprod-id', actualProfile: 'Preprod Push30' })).toBe(
      '"Dev Push30" now reaches the cluster of "Preprod Push30", not the cluster it was saved with (dev-id). Writes are blocked until you confirm it.',
    );
  });
});
