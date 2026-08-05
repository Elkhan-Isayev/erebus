import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/** Runs an async loader, re-running when `deps` change. Keeps stale data while refreshing. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], options: { enabled?: boolean } = {}): AsyncState<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const hasData = data !== undefined;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (hasData) setRefreshing(true);
    else setLoading(true);

    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const update = useCallback((updater: T | ((prev: T | undefined) => T)) => {
    setData((prev) => (typeof updater === 'function' ? (updater as (p: T | undefined) => T)(prev) : updater));
  }, []);

  return { data, error, loading, refreshing, reload, setData: update };
}

/** Debounced mirror of a rapidly changing value (search boxes). */
export function useDebounced<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export type SortDirection = 'asc' | 'desc';

export interface Sorter<T> {
  key: keyof T & string;
  direction: SortDirection;
  toggle: (key: keyof T & string) => void;
  sort: (rows: T[]) => T[];
}

export function useSort<T extends Record<string, unknown>>(
  initialKey: keyof T & string,
  initialDirection: SortDirection = 'asc',
): Sorter<T> {
  const [key, setKey] = useState<keyof T & string>(initialKey);
  const [direction, setDirection] = useState<SortDirection>(initialDirection);

  const toggle = useCallback(
    (next: keyof T & string) => {
      if (next === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setKey(next);
        setDirection('asc');
      }
    },
    [key],
  );

  const sort = useCallback(
    (rows: T[]) => {
      const factor = direction === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
        const an = Number(av);
        const bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') return (an - bn) * factor;
        return String(av ?? '').localeCompare(String(bv ?? '')) * factor;
      });
    },
    [key, direction],
  );

  return useMemo(() => ({ key, direction, toggle, sort }), [key, direction, toggle, sort]);
}

/** Calls `handler` on an interval while `seconds` is non-zero. */
export function useInterval(handler: () => void, seconds: number): void {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!seconds) return;
    const timer = setInterval(() => saved.current(), seconds * 1000);
    return () => clearInterval(timer);
  }, [seconds]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage full or unavailable — keep the in-memory value */
      }
    },
    [key],
  );
  return [value, update];
}
