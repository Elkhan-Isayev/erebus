export function formatNumber(value: string | number | undefined | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US');
}

export function compactNumber(value: string | number | undefined | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatBytes(bytes: string | number | undefined | null): string {
  const n = typeof bytes === 'string' ? Number(bytes) : (bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTimestamp(ts: string | number | undefined | null): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (v: number, size = 2) => String(v).padStart(size, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDuration(ms: string | number | undefined | null): string {
  const n = typeof ms === 'string' ? Number(ms) : (ms ?? 0);
  if (!Number.isFinite(n)) return String(ms);
  if (n < 0) return 'infinite';
  if (n === 0) return '0';
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, label] of units) {
    if (n >= size) {
      const value = n / size;
      return `${Number.isInteger(value) ? value : value.toFixed(1)}${label}`;
    }
  }
  return `${n}ms`;
}

export function relativeTime(ts: number | undefined | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1_000, 'second'],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [size, unit] of units) {
    if (abs >= size) return rtf.format(-Math.round(diff / size), unit);
  }
  return 'just now';
}

/** Minimal JSON syntax highlighting — returns HTML with themed spans. */
export function highlightJson(source: string): string {
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (match.startsWith('"')) cls = match.trimEnd().endsWith(':') ? 'json-key' : 'json-string';
      else if (match === 'true' || match === 'false') cls = 'json-bool';
      else if (match === 'null') cls = 'json-null';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
