import { useCallback, useEffect, useSyncExternalStore } from 'react';

/** A hash router small enough to read in one sitting — no dependency needed. */

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, currentPath, currentPath);
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = `#${path}`;
  if (window.location.hash === target) return;
  if (options.replace) window.history.replaceState(null, '', target);
  else window.location.hash = path;
  if (options.replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useNavigate() {
  return useCallback((path: string, options?: { replace?: boolean }) => navigate(path, options), []);
}

/** Matches `/c/:clusterId/topics/:topic` style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const [pathname] = path.split('?');
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  const params: Record<string, string> = {};

  const wildcard = patternParts[patternParts.length - 1] === '*';
  if (!wildcard && patternParts.length !== pathParts.length) return null;
  if (wildcard && pathParts.length < patternParts.length - 1) return null;

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*') return params;
    const value = pathParts[i];
    if (p.startsWith(':')) {
      if (value === undefined) return null;
      params[p.slice(1)] = decodeURIComponent(value);
    } else if (p !== value) {
      return null;
    }
  }
  return params;
}

export function queryParams(path: string): URLSearchParams {
  const idx = path.indexOf('?');
  return new URLSearchParams(idx >= 0 ? path.slice(idx + 1) : '');
}

/** Keeps `document.title` in sync with the active page. */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Erebus` : 'Erebus';
  }, [title]);
}
