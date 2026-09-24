import { describe, expect, it } from 'vitest';
import { describeMisroute } from './brokerRoutes';

describe('describeMisroute', () => {
  it('names the other cluster when one answers', () => {
    const text = describeMisroute([
      { nodeId: 1, advertised: 'localhost:9094', connectsTo: 'localhost:9094', reachedClusterId: 'preprod-id', ok: false },
    ]);
    expect(text).toBe(
      'Broker 1 advertises localhost:9094, but a different cluster (preprod-id) answers there — reads and writes go to that cluster.',
    );
  });

  it('shows the dialled address when an override rewrote it', () => {
    const text = describeMisroute([
      { nodeId: 2, advertised: 'kafka-2:9094', connectsTo: 'localhost:1', reachedClusterId: null, ok: false, error: 'Connection error: ECONNREFUSED' },
    ]);
    expect(text).toBe('Broker 2 advertises kafka-2:9094 (dialled as localhost:1), which is not reachable: Connection error: ECONNREFUSED.');
  });

  it('joins several brokers into one message', () => {
    const route = { advertised: 'a:1', connectsTo: 'a:1', reachedClusterId: null, ok: false };
    expect(describeMisroute([{ ...route, nodeId: 1 }, { ...route, nodeId: 2 }])).toBe(
      'Broker 1 advertises a:1, which is not reachable: no answer. Broker 2 advertises a:1, which is not reachable: no answer.',
    );
  });
});
