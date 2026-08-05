import { useEffect, useMemo, useState } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from './Icons';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';
import { cx } from '@/lib/format';
import { useAppState } from '@/app/AppState';

interface Command {
  id: string;
  label: string;
  kind: string;
  icon: JSX.Element;
  run: () => void;
}

export function CommandPalette({ cluster, onClose }: { cluster: ClusterConfig | null; onClose: () => void }) {
  const { clusters, cycleTheme } = useAppState();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const topics = useAsync(() => api.topics(cluster!.id), [cluster?.id], { enabled: Boolean(cluster) });

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (cluster) {
      const pages: [string, string, JSX.Element][] = [
        ['Dashboard', 'dashboard', <Icon.Dashboard key="d" />],
        ['Brokers', 'brokers', <Icon.Server key="b" />],
        ['Topics', 'topics', <Icon.Topics key="t" />],
        ['Consumer groups', 'groups', <Icon.Groups key="g" />],
        ['Schema Registry', 'schemas', <Icon.Schema key="s" />],
        ['Kafka Connect', 'connect', <Icon.Plug key="c" />],
        ['ksqlDB', 'ksql', <Icon.Terminal key="k" />],
        ['ACL', 'acls', <Icon.Shield key="a" />],
      ];
      for (const [label, path, icon] of pages) {
        list.push({
          id: `page:${path}`,
          label,
          kind: 'Go to',
          icon,
          run: () => navigate(`/c/${cluster.id}/${path}`),
        });
      }
      for (const topic of topics.data ?? []) {
        list.push({
          id: `topic:${topic.name}`,
          label: topic.name,
          kind: 'Topic',
          icon: <Icon.Topics />,
          run: () => navigate(`/c/${cluster.id}/topics/${encodeURIComponent(topic.name)}?tab=messages`),
        });
      }
    }
    for (const c of clusters) {
      if (c.id === cluster?.id) continue;
      list.push({
        id: `cluster:${c.id}`,
        label: c.name,
        kind: 'Cluster',
        icon: <Icon.Database />,
        run: () => navigate(`/c/${c.id}/dashboard`),
      });
    }
    list.push(
      { id: 'clusters', label: 'Manage clusters', kind: 'App', icon: <Icon.Database />, run: () => navigate('/clusters') },
      { id: 'settings', label: 'Settings', kind: 'App', icon: <Icon.Settings />, run: () => navigate('/settings') },
      { id: 'theme', label: 'Toggle theme', kind: 'App', icon: <Icon.Moon />, run: cycleTheme },
    );
    return list;
  }, [cluster, clusters, topics.data, cycleTheme]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 40);
    return commands.filter((c) => c.label.toLowerCase().includes(needle) || c.kind.toLowerCase().includes(needle)).slice(0, 40);
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);

  const runAt = (index: number) => {
    const command = results[index];
    if (!command) return;
    command.run();
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          autoFocus
          value={query}
          placeholder="Jump to a topic, page or cluster…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter') runAt(cursor);
          }}
        />
        <div className="results">
          {results.map((command, index) => (
            <button
              key={command.id}
              className={cx(index === cursor && 'active')}
              onMouseEnter={() => setCursor(index)}
              onClick={() => runAt(index)}
            >
              {command.icon}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{command.label}</span>
              <span className="kind">{command.kind}</span>
            </button>
          ))}
          {results.length === 0 && <div className="empty">Nothing matches “{query}”</div>}
        </div>
      </div>
    </div>
  );
}
