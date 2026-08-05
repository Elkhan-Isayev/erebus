import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppState } from '@/app/AppState';
import { Layout } from '@/app/Layout';
import { CommandPalette } from '@/components/CommandPalette';
import { TerminalPanel } from '@/components/TerminalPanel';
import { Button, EmptyState, Loading } from '@/components/ui';
import { Icon } from '@/components/Icons';
import { bridge } from '@/lib/api';
import { cx } from '@/lib/format';
import { match, navigate, queryParams, useRoute, useTitle } from '@/lib/router';
import { useLocalStorage } from '@/lib/hooks';
import { api } from '@/lib/api';
import type { TerminalSession } from '@shared/types';
import { AclsPage } from '@/pages/AclsPage';
import { BrokersPage } from '@/pages/BrokersPage';
import { ClustersPage } from '@/pages/ClustersPage';
import { ConnectPage } from '@/pages/ConnectPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { GroupPage } from '@/pages/GroupPage';
import { GroupsPage } from '@/pages/GroupsPage';
import { KsqlPage } from '@/pages/KsqlPage';
import { SchemasPage } from '@/pages/SchemasPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TopicPage } from '@/pages/TopicPage';
import { TopicsPage } from '@/pages/TopicsPage';
import { RabbitConnectionsPage } from '@/pages/rabbit/RabbitConnectionsPage';
import { RabbitExchangesPage } from '@/pages/rabbit/RabbitExchangesPage';
import { RabbitOverviewPage } from '@/pages/rabbit/RabbitOverviewPage';
import { RabbitQueuesPage } from '@/pages/rabbit/RabbitQueuesPage';

type TopicTab = 'overview' | 'messages' | 'consumers' | 'settings';

export default function App() {
  const route = useRoute();
  const { clusters, ready, cycleTheme } = useAppState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newClusterRequested, setNewClusterRequested] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  /* ----------------------------------------------------------- terminal */
  const [terminalOpen, setTerminalOpen] = useLocalStorage('erebus.terminal.open', false);
  const [terminalHeight, setTerminalHeight] = useLocalStorage('erebus.terminal.height', 260);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  useEffect(() => {
    void api.terminalList().then((list) => {
      setSessions(list);
      // Auto-started port-forwards should be visible without hunting for them.
      if (list.length > 0) {
        setActiveSession((current) => current ?? list[0].id);
        setTerminalOpen(true);
      }
    });
    return bridge.on('terminal:sessions', (payload) => setSessions(payload as TerminalSession[]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTerminal = useCallback(async () => {
    const session = await api.terminalCreate();
    setActiveSession(session.id);
    setTerminalOpen(true);
  }, [setTerminalOpen]);

  const closeSession = useCallback(
    async (id: string) => {
      await api.terminalClose(id);
      setActiveSession((current) => (current === id ? (sessions.find((s) => s.id !== id)?.id ?? null) : current));
    },
    [sessions],
  );

  /* --------------------------------------------------------- global keys */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault();
        setTerminalOpen(!terminalOpen);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        void openTerminal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [terminalOpen, setTerminalOpen, openTerminal]);

  useEffect(() => {
    const offs = [
      bridge.on('menu:palette', () => setPaletteOpen(true)),
      bridge.on('menu:toggle-theme', () => cycleTheme()),
      bridge.on('menu:new-cluster', () => {
        setNewClusterRequested(true);
        navigate('/clusters');
      }),
      bridge.on('menu:refresh', () => setRefreshKey((k) => k + 1)),
      bridge.on('menu:toggle-terminal', () => setTerminalOpen(!terminalOpen)),
      bridge.on('menu:new-terminal', () => void openTerminal()),
    ];
    return () => offs.forEach((off) => off());
  }, [cycleTheme, terminalOpen, setTerminalOpen, openTerminal]);

  /* -------------------------------------------------------------- routing */
  const clusterMatch = match('/c/:clusterId/*', route);
  const cluster = useMemo(
    () => clusters.find((c) => c.id === clusterMatch?.clusterId) ?? null,
    [clusters, clusterMatch?.clusterId],
  );

  useEffect(() => {
    if (!ready) return;
    if (route === '/' || route === '') {
      navigate(clusters.length > 0 ? `/c/${clusters[0].id}/dashboard` : '/clusters', { replace: true });
    }
  }, [ready, route, clusters]);

  const params = queryParams(route);

  let title = 'Erebus';
  let breadcrumb: ReactNode = null;
  let content: ReactNode = null;
  let flush = false;

  if (!ready) {
    content = <Loading label="Starting Erebus…" />;
  } else if (match('/clusters', route)) {
    title = 'Clusters';
    breadcrumb = <span className="current">Clusters</span>;
    content = <ClustersPage openForm={newClusterRequested} onFormClosed={() => setNewClusterRequested(false)} />;
  } else if (match('/settings', route)) {
    title = 'Settings';
    breadcrumb = <span className="current">Settings</span>;
    content = <SettingsPage />;
  } else if (clusterMatch && !cluster) {
    content = (
      <EmptyState
        icon={<Icon.Database />}
        title="This cluster is not configured any more"
        description="It may have been removed. Pick another cluster or add a new one."
        action={
          <Button variant="primary" onClick={() => navigate('/clusters')}>
            Manage clusters
          </Button>
        }
      />
    );
  } else if (cluster) {
    const base = `/c/${cluster.id}`;
    const crumb = (label: string, path?: string) =>
      path ? (
        <span className="crumb" onClick={() => navigate(path)}>
          {label}
        </span>
      ) : (
        <span className="current">{label}</span>
      );

    const topicRoute = match('/c/:clusterId/topics/:topic', route);
    const groupRoute = match('/c/:clusterId/groups/:groupId', route);

    if (cluster.kind === 'rabbitmq') {
      if (match('/c/:clusterId/queues', route)) {
        title = `Queues · ${cluster.name}`;
        breadcrumb = crumb('Queues');
        content = <RabbitQueuesPage key={refreshKey} cluster={cluster} />;
      } else if (match('/c/:clusterId/exchanges', route)) {
        title = `Exchanges · ${cluster.name}`;
        breadcrumb = crumb('Exchanges');
        content = <RabbitExchangesPage key={refreshKey} cluster={cluster} />;
      } else if (match('/c/:clusterId/connections', route)) {
        title = `Connections · ${cluster.name}`;
        breadcrumb = crumb('Connections');
        content = <RabbitConnectionsPage key={refreshKey} cluster={cluster} />;
      } else {
        title = cluster.name;
        breadcrumb = crumb('Overview');
        content = <RabbitOverviewPage key={refreshKey} cluster={cluster} />;
      }
    } else if (match('/c/:clusterId/dashboard', route)) {
      title = cluster.name;
      breadcrumb = crumb('Dashboard');
      content = <DashboardPage key={refreshKey} cluster={cluster} />;
    } else if (match('/c/:clusterId/brokers', route)) {
      title = `Brokers · ${cluster.name}`;
      breadcrumb = crumb('Brokers');
      const node = params.get('node');
      content = <BrokersPage key={refreshKey} cluster={cluster} initialNode={node ? Number(node) : undefined} />;
    } else if (topicRoute) {
      const topic = topicRoute.topic;
      const tab = (params.get('tab') as TopicTab) || 'overview';
      title = `${topic} · ${cluster.name}`;
      flush = false;
      breadcrumb = (
        <>
          {crumb('Topics', `${base}/topics`)}
          <span className="sep">/</span>
          {crumb(topic)}
        </>
      );
      content = (
        <TopicPage
          key={`${refreshKey}-${topic}`}
          cluster={cluster}
          topic={topic}
          tab={tab}
          onTabChange={(next) => navigate(`${base}/topics/${encodeURIComponent(topic)}?tab=${next}`)}
        />
      );
    } else if (match('/c/:clusterId/topics', route)) {
      title = `Topics · ${cluster.name}`;
      breadcrumb = crumb('Topics');
      content = <TopicsPage key={refreshKey} cluster={cluster} />;
    } else if (groupRoute) {
      title = `${groupRoute.groupId} · ${cluster.name}`;
      breadcrumb = (
        <>
          {crumb('Consumers', `${base}/groups`)}
          <span className="sep">/</span>
          {crumb(groupRoute.groupId)}
        </>
      );
      content = <GroupPage key={refreshKey} cluster={cluster} groupId={groupRoute.groupId} />;
    } else if (match('/c/:clusterId/groups', route)) {
      title = `Consumers · ${cluster.name}`;
      breadcrumb = crumb('Consumers');
      content = <GroupsPage key={refreshKey} cluster={cluster} />;
    } else if (match('/c/:clusterId/schemas', route)) {
      title = `Schemas · ${cluster.name}`;
      breadcrumb = crumb('Schema Registry');
      content = <SchemasPage key={refreshKey} cluster={cluster} />;
    } else if (match('/c/:clusterId/connect', route)) {
      title = `Connect · ${cluster.name}`;
      breadcrumb = crumb('Kafka Connect');
      content = <ConnectPage key={refreshKey} cluster={cluster} />;
    } else if (match('/c/:clusterId/ksql', route)) {
      title = `ksqlDB · ${cluster.name}`;
      breadcrumb = crumb('ksqlDB');
      content = <KsqlPage key={refreshKey} cluster={cluster} />;
    } else if (match('/c/:clusterId/acls', route)) {
      title = `ACL · ${cluster.name}`;
      breadcrumb = crumb('ACL');
      content = <AclsPage key={refreshKey} cluster={cluster} />;
    }
  }

  if (content === null) {
    content = (
      <EmptyState
        title="Page not found"
        description={route}
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            Go home
          </Button>
        }
      />
    );
  }

  useTitle(title === 'Erebus' ? '' : title);

  return (
    <>
      <Layout
        cluster={cluster}
        breadcrumb={breadcrumb}
        flush={flush}
        topbarExtra={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTerminalOpen(!terminalOpen)}
              title="Toggle terminal (⌘`)"
              className={cx(terminalOpen && 'primary')}
            >
              <Icon.Terminal width={14} />
              {sessions.some((s) => s.status === 'running') && <span className="live-dot" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)} title="Command palette">
              <Icon.Search width={14} />
              <span className="subtle">{window.erebus.platform === 'darwin' ? '⌘K' : 'Ctrl K'}</span>
            </Button>
          </>
        }
        bottomPanel={
          terminalOpen ? (
            <TerminalPanel
              sessions={sessions}
              activeId={activeSession}
              onActivate={setActiveSession}
              onClose={(id) => void closeSession(id)}
              height={terminalHeight}
              onHeightChange={setTerminalHeight}
              onHide={() => setTerminalOpen(false)}
            />
          ) : null
        }
      >
        {content}
      </Layout>
      {paletteOpen && <CommandPalette cluster={cluster} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}
