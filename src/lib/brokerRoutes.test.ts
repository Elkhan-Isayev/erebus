import { describe, expect, it } from 'vitest';
import type { BrokerRoute } from '@shared/types';
import { describeIdentityChange, describeMisroute } from './brokerRoutes';

const route = (over: Partial<BrokerRoute>): BrokerRoute => ({
  nodeId: 1,
  advertised: 'localhost:9094',
  connectsTo: 'localhost:9094',
  reachedClusterId: null,
  reachedProfile: null,
  ok: false,
  ...over,
});

describe('describeMisroute', () => {
  it('names the saved profile whose cluster answers, not just its id', () => {
    expect(describeMisroute([route({ reachedClusterId: 'preprod-id', reachedProfile: 'Preprod Push30' })])).toBe(
      'Broker 1 advertises localhost:9094, but the cluster of "Preprod Push30" (preprod-id) answers there — reads and writes go to that cluster.',
    );
  });

  it('falls back to the id when no profile knows that cluster', () => {
    expect(describeMisroute([route({ reachedClusterId: 'unknown-id' })])).toBe(
      'Broker 1 advertises localhost:9094, but a different cluster (unknown-id) answers there — reads and writes go to that cluster.',
    );
  });

  it('shows the dialled address when an override rewrote it', () => {
    expect(describeMisroute([route({ nodeId: 2, advertised: 'kafka-2:9094', connectsTo: 'localhost:1', error: 'Connection error: ECONNREFUSED' })])).toBe(
      'Broker 2 advertises kafka-2:9094 (dialled as localhost:1), which is not reachable: Connection error: ECONNREFUSED.',
    );
  });

  it('joins several brokers into one message', () => {
    expect(describeMisroute([route({ nodeId: 1, advertised: 'a:1', connectsTo: 'a:1' }), route({ nodeId: 2, advertised: 'a:1', connectsTo: 'a:1' })])).toBe(
      'Broker 1 advertises a:1, which is not reachable: no answer. Broker 2 advertises a:1, which is not reachable: no answer.',
    );
  });
});

describe('describeIdentityChange', () => {
  it('shows what was expected and what answers, by profile name', () => {
    expect(describeIdentityChange('Dev Push30', { status: 'changed', expected: 'dev-id', actual: 'preprod-id', actualProfile: 'Preprod Push30' })).toBe(
      '"Dev Push30" was saved with cluster dev-id, but the cluster of "Preprod Push30" (preprod-id) answers at its address now.',
    );
  });

  it('explains a first sight of a cluster another profile owns', () => {
    expect(describeIdentityChange('Staging', { status: 'changed', expected: null, actual: 'prod-id', actualProfile: 'Prod' })).toBe(
      '"Staging" reaches the cluster of "Prod" (prod-id), which another profile already uses.',
    );
  });
});
