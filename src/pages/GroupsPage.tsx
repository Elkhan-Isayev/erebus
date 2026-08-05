import { useMemo, useState } from 'react';
import type { ClusterConfig, ConsumerGroupSummary } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorBanner,
  Loading,
  PageHead,
  SearchInput,
  StateBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useAsync, useSort } from '@/lib/hooks';
import { navigate } from '@/lib/router';

export function GroupsPage({ cluster }: { cluster: ClusterConfig }) {
  const groups = useAsync(() => api.groups(cluster.id), [cluster.id]);
  const [search, setSearch] = useState('');
  const sorter = useSort<ConsumerGroupSummary & Record<string, unknown>>('groupId');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (groups.data ?? []).filter(
      (g) => !needle || g.groupId.toLowerCase().includes(needle) || g.topics.some((t) => t.toLowerCase().includes(needle)),
    );
    return sorter.sort(filtered as (ConsumerGroupSummary & Record<string, unknown>)[]);
  }, [groups.data, search, sorter]);

  return (
    <>
      <PageHead
        title="Consumer groups"
        subtitle={groups.data ? `${formatNumber(rows.length)} of ${formatNumber(groups.data.length)} groups` : undefined}
        actions={
          <Button onClick={groups.reload} loading={groups.refreshing}>
            <Icon.Refresh width={14} /> Refresh
          </Button>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter by group or topic…" />
      </div>

      {groups.loading && <Loading label="Describing consumer groups…" />}
      {groups.error && <ErrorBanner error={groups.error} onRetry={groups.reload} />}
      {groups.data && (
        <DataTable
          rows={rows}
          rowKey={(g) => g.groupId}
          sortKey={sorter.key}
          sortDirection={sorter.direction}
          onSort={(key) => sorter.toggle(key as never)}
          onRowClick={(g) => navigate(`/c/${cluster.id}/groups/${encodeURIComponent(g.groupId)}`)}
          empty={<EmptyState icon={<Icon.Groups />} title="No consumer groups" description="Groups appear once a consumer connects." />}
          columns={[
            { key: 'groupId', header: 'Group', sortable: true, render: (g) => <span className="mono link-cell">{g.groupId}</span> },
            { key: 'state', header: 'State', sortable: true, render: (g) => <StateBadge state={g.state} /> },
            { key: 'members', header: 'Members', sortable: true, align: 'right', render: (g) => g.members },
            {
              key: 'topics',
              header: 'Topics',
              render: (g) => (
                <div className="chip-list">
                  {g.topics.slice(0, 3).map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                  {g.topics.length > 3 && <Badge>+{g.topics.length - 3}</Badge>}
                </div>
              ),
            },
            {
              key: 'lag',
              header: 'Lag',
              sortable: true,
              align: 'right',
              render: (g) =>
                g.lag === '-1' ? (
                  <span className="subtle">n/a</span>
                ) : (
                  <span className="num" style={Number(g.lag) > 0 ? { color: 'var(--warning)' } : undefined}>
                    {formatNumber(g.lag)}
                  </span>
                ),
            },
            { key: 'protocol', header: 'Assignor', render: (g) => <span className="mono subtle">{g.protocol || '—'}</span> },
          ]}
        />
      )}
    </>
  );
}
