import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Button } from '@/components/ui';
import { cx } from '@/lib/format';
import { navigate, useRoute } from '@/lib/router';
import { useAppState } from './AppState';

const KAFKA_NAV = [
  { path: 'dashboard', label: 'Dashboard', icon: Icon.Dashboard },
  { path: 'brokers', label: 'Brokers', icon: Icon.Server },
  { path: 'topics', label: 'Topics', icon: Icon.Topics },
  { path: 'groups', label: 'Consumers', icon: Icon.Groups },
  { path: 'schemas', label: 'Schema Registry', icon: Icon.Schema },
  { path: 'connect', label: 'Kafka Connect', icon: Icon.Plug },
  { path: 'ksql', label: 'ksqlDB', icon: Icon.Terminal },
  { path: 'acls', label: 'ACL', icon: Icon.Shield },
];

const RABBIT_NAV = [
  { path: 'dashboard', label: 'Overview', icon: Icon.Dashboard },
  { path: 'queues', label: 'Queues', icon: Icon.Inbox },
  { path: 'exchanges', label: 'Exchanges', icon: Icon.Topics },
  { path: 'connections', label: 'Connections', icon: Icon.Plug },
];

const navFor = (kind: ClusterConfig['kind']) => (kind === 'rabbitmq' ? RABBIT_NAV : KAFKA_NAV);

export const endpointOf = (cluster: ClusterConfig) =>
  cluster.kind === 'rabbitmq' ? (cluster.rabbit?.url ?? '') : cluster.bootstrapServers;

function ClusterSwitcher({ cluster }: { cluster: ClusterConfig | null }) {
  const { clusters } = useAppState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="cluster-switcher" ref={ref}>
      <button onClick={() => setOpen((v) => !v)}>
        <span className="dot" style={cluster?.color ? { background: cluster.color } : undefined} />
        <span className="meta">
          <b>{cluster ? cluster.name : 'No cluster selected'}</b>
          <span>{cluster ? endpointOf(cluster) : `${clusters.length} configured`}</span>
        </span>
        <Icon.ChevronDown width={14} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
      {open && (
        <div className="dropdown">
          {clusters.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setOpen(false);
                navigate(`/c/${c.id}/dashboard`);
              }}
            >
              <span className="dot" style={{ background: c.color ?? 'var(--accent)', width: 8, height: 8, borderRadius: 4 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}
              </span>
              <span className="badge">{c.kind === 'rabbitmq' ? 'RMQ' : 'Kafka'}</span>
              {c.readonly && <span className="badge">RO</span>}
              {cluster?.id === c.id && <Icon.Check width={14} />}
            </button>
          ))}
          {clusters.length > 0 && <div className="divider" />}
          <button
            onClick={() => {
              setOpen(false);
              navigate('/clusters');
            }}
          >
            <Icon.Database width={15} />
            Manage clusters
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout({
  cluster,
  breadcrumb,
  children,
  flush,
  topbarExtra,
  bottomPanel,
}: {
  cluster: ClusterConfig | null;
  breadcrumb?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  topbarExtra?: ReactNode;
  bottomPanel?: ReactNode;
}) {
  const route = useRoute();
  const { resolvedTheme, cycleTheme, theme } = useAppState();
  const isMac = window.erebus.platform === 'darwin';

  const ThemeIcon = theme === 'system' ? Icon.Monitor : resolvedTheme === 'dark' ? Icon.Moon : Icon.Sun;

  return (
    <div className={cx('app', isMac && 'mac')}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <Icon.Logo className="logo" />
          <span className="name">Erebus</span>
        </div>
        <ClusterSwitcher cluster={cluster} />
        <nav className="nav">
          {cluster ? (
            navFor(cluster.kind).map((item) => {
              const href = `/c/${cluster.id}/${item.path}`;
              const active = route.startsWith(href);
              const IconComponent = item.icon;
              return (
                <a
                  key={item.path}
                  href={`#${href}`}
                  className={cx(active && 'active')}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  <IconComponent />
                  {item.label}
                </a>
              );
            })
          ) : (
            <>
              <div className="nav-group-label">Start here</div>
              <a
                href="#/clusters"
                className={cx(route.startsWith('/clusters') && 'active')}
                onClick={(e) => {
                  e.preventDefault();
                  navigate('/clusters');
                }}
              >
                <Icon.Database />
                Clusters
              </a>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <Button variant="ghost" size="sm" iconOnly title={`Theme: ${theme}`} onClick={cycleTheme}>
            <ThemeIcon width={15} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title="Clusters"
            onClick={() => navigate('/clusters')}
          >
            <Icon.Database width={15} />
          </Button>
          <Button variant="ghost" size="sm" iconOnly title="Settings" onClick={() => navigate('/settings')}>
            <Icon.Settings width={15} />
          </Button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">{breadcrumb}</div>
          <div className="spacer" />
          {topbarExtra}
        </header>
        <div className={cx('content', flush && 'flush')}>{children}</div>
        {bottomPanel}
      </main>
    </div>
  );
}
