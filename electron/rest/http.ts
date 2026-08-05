export interface RestTarget {
  url: string;
  username?: string;
  password?: string;
}

function authHeader(t: RestTarget): Record<string, string> {
  if (!t.username) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${t.username}:${t.password ?? ''}`).toString('base64') };
}

export async function restRequest<T>(
  target: RestTarget,
  pathname: string,
  init: { method?: string; body?: unknown; accept?: string; contentType?: string; timeoutMs?: number } = {},
): Promise<T> {
  const base = target.url.replace(/\/+$/, '');
  const url = `${base}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Accept: init.accept ?? 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': init.contentType ?? 'application/json' } : {}),
        ...authHeader(target),
      },
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message ?? parsed.error_message ?? parsed.error ?? message;
      } catch {
        if (text) message = `${message}: ${text.slice(0, 400)}`;
      }
      throw new Error(message);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`Request to ${url} timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
