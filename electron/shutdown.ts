export interface ShutdownSteps {
  stopConsumers: () => void;
  disconnect: () => Promise<unknown>;
  killTerminals: () => void;
  exit: () => void;
}

/** Longest we let a polite Kafka goodbye hold up Cmd+Q. */
export const QUIT_GRACE_MS = 1_500;

/**
 * kafkajs' disconnect waits for every in-flight request, and a request to a broker whose
 * port-forward is gone only returns after requestTimeout (30s by default). So the goodbye
 * is bounded, the port-forwards stay up until it is said — killing them first is what
 * left requests hanging — and the caller's exit must be one nothing can veto.
 */
export async function shutdown(steps: ShutdownSteps, graceMs = QUIT_GRACE_MS): Promise<void> {
  steps.stopConsumers();
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([steps.disconnect().catch(() => {}), grace]);
  } finally {
    clearTimeout(timer);
    steps.killTerminals();
    steps.exit();
  }
}
