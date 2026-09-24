import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIT_GRACE_MS, shutdown } from './shutdown';

describe('shutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function steps(disconnect: () => Promise<unknown>) {
    const order: string[] = [];
    return {
      order,
      steps: {
        stopConsumers: () => order.push('stopConsumers'),
        disconnect: () => (order.push('disconnect'), disconnect()),
        killTerminals: () => order.push('killTerminals'),
        exit: () => order.push('exit'),
      },
    };
  }

  it('exits once the grace period runs out, even if a broker never answers', async () => {
    const { order, steps: s } = steps(() => new Promise(() => {}));
    const done = shutdown(s);

    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS - 1);
    expect(order).not.toContain('exit');

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(order).toEqual(['stopConsumers', 'disconnect', 'killTerminals', 'exit']);
  });

  it('does not wait out the grace period when the disconnect is quick', async () => {
    const { order, steps: s } = steps(() => Promise.resolve());
    await shutdown(s);
    expect(order).toEqual(['stopConsumers', 'disconnect', 'killTerminals', 'exit']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps port-forwards up until the disconnect has had its chance', async () => {
    let finish!: () => void;
    const { order, steps: s } = steps(() => new Promise<void>((resolve) => (finish = resolve)));
    const done = shutdown(s);

    await vi.advanceTimersByTimeAsync(100);
    expect(order).not.toContain('killTerminals');

    finish();
    await done;
    expect(order.indexOf('killTerminals')).toBeGreaterThan(order.indexOf('disconnect'));
  });

  it('still exits when the disconnect fails', async () => {
    const { order, steps: s } = steps(() => Promise.reject(new Error('socket hang up')));
    await shutdown(s);
    expect(order.at(-1)).toBe('exit');
  });
});
