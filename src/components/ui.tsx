import {
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './Icons';
import { cx, highlightJson } from '@/lib/format';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';

/* ----------------------------------------------------------------- buttons */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  loading?: boolean;
  iconOnly?: boolean;
}

export function Button({ variant = 'default', size = 'md', loading, iconOnly, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('btn', variant !== 'default' && variant, size === 'sm' && 'sm', iconOnly && 'icon', className)}
    >
      {loading ? <span className="spinner" /> : children}
    </button>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('field', className)}>
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={cx('input', props.className)} />
);

export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={cx('textarea', props.className)} spellCheck={false} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={cx('select', props.className)} />
);

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="search-box grow">
      <Icon.Search />
      <input
        className="input"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ badges */

export function Badge({ tone = 'default', children }: { tone?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={cx('badge', tone !== 'default' && tone)}>{children}</span>;
}

const STATE_TONES: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
  Stable: 'success',
  RUNNING: 'success',
  Empty: 'default',
  PreparingRebalance: 'warning',
  CompletingRebalance: 'warning',
  PAUSED: 'warning',
  Dead: 'danger',
  FAILED: 'danger',
  UNREACHABLE: 'danger',
  UNASSIGNED: 'warning',
};

export const StateBadge = ({ state }: { state: string }) => <Badge tone={STATE_TONES[state] ?? 'info'}>{state}</Badge>;

/* ------------------------------------------------------------------ layout */

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button key={tab.id} className={cx(active === tab.id && 'active')} onClick={() => onChange(tab.id)}>
          {tab.label}
          {tab.badge !== undefined && <span className="subtle"> {tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button key={option.value} className={cx(value === option.value && 'active')} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'danger' | 'warning';
}) {
  return (
    <div className={cx('stat', tone)}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export const Loading = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="loading-row">
    <span className="spinner" />
    {label}
  </div>
);

export const ErrorBanner = ({ error, onRetry }: { error: string; onRetry?: () => void }) => (
  <div className="error-banner">
    <Icon.Alert width={16} />
    <div style={{ flex: 1 }}>{error}</div>
    {onRetry && (
      <Button size="sm" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ?? <Icon.Inbox />}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ modals */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" iconOnly className="close" onClick={onClose} aria-label="Close">
            <Icon.X width={16} />
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  requireText,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = Boolean(requireText) && typed !== requireText;

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={blocked} loading={busy} onClick={run}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ marginBottom: requireText ? 14 : 0 }}>{message}</div>
      {requireText && (
        <Field label={`Type “${requireText}” to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------- data */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
  width?: number | string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sortKey,
  sortDirection,
  onSort,
  selectedKey,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  selectedKey?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="table-wrap card">
      <table className="data">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={cx(col.sortable && onSort && 'sortable', col.align === 'right' && 'right')}
                style={col.width ? { width: col.width } : undefined}
                onClick={col.sortable && onSort ? () => onSort(col.key) : undefined}
              >
                {col.header}
                {sortKey === col.key && <span className="subtle"> {sortDirection === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={cx(onRowClick && 'clickable', selectedKey === key && 'selected')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} className={cx(col.align === 'right' && 'right')}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------- code */

export function CodeBlock({ children, language, tall }: { children: string; language?: 'json' | 'text'; tall?: boolean }) {
  const html = useMemo(
    () => (language === 'json' ? highlightJson(children) : null),
    [children, language],
  );
  if (html) return <pre className={cx('code', tall && 'tall')} dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className={cx('code', tall && 'tall')}>{children}</pre>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly={!label}
      title="Copy to clipboard"
      onClick={(e) => {
        e.stopPropagation();
        void api.copy(text).then(() => toast.success('Copied'));
      }}
    >
      <Icon.Copy width={14} />
      {label}
    </Button>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([key, value], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
