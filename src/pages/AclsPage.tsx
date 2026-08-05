import { useMemo, useState } from 'react';
import type { AclEntry, ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Loading,
  Modal,
  PageHead,
  SearchInput,
  Select,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

/** Mirrors kafkajs' ACL enums so the UI can show names instead of numbers. */
const RESOURCE_TYPES: Record<string, string> = {
  '0': 'UNKNOWN',
  '1': 'ANY',
  '2': 'TOPIC',
  '3': 'GROUP',
  '4': 'CLUSTER',
  '5': 'TRANSACTIONAL_ID',
  '6': 'DELEGATION_TOKEN',
};
const PATTERN_TYPES: Record<string, string> = { '0': 'UNKNOWN', '1': 'ANY', '2': 'MATCH', '3': 'LITERAL', '4': 'PREFIXED' };
const OPERATIONS: Record<string, string> = {
  '0': 'UNKNOWN',
  '1': 'ANY',
  '2': 'ALL',
  '3': 'READ',
  '4': 'WRITE',
  '5': 'CREATE',
  '6': 'DELETE',
  '7': 'ALTER',
  '8': 'DESCRIBE',
  '9': 'CLUSTER_ACTION',
  '10': 'DESCRIBE_CONFIGS',
  '11': 'ALTER_CONFIGS',
  '12': 'IDEMPOTENT_WRITE',
};
const PERMISSIONS: Record<string, string> = { '0': 'UNKNOWN', '1': 'ANY', '2': 'DENY', '3': 'ALLOW' };

const options = (map: Record<string, string>, skip: string[] = ['0', '1']) =>
  Object.entries(map)
    .filter(([value]) => !skip.includes(value))
    .map(([value, label]) => (
      <option key={value} value={value}>
        {label}
      </option>
    ));

function CreateAclModal({ cluster, onClose, onDone }: { cluster: ClusterConfig; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [entry, setEntry] = useState<AclEntry>({
    resourceType: '2',
    resourceName: '*',
    resourcePatternType: '3',
    principal: 'User:',
    host: '*',
    operation: '3',
    permissionType: '3',
  });
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Create ACL"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.createAcl(cluster.id, entry);
                toast.success('ACL created');
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create ACL
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Resource type">
          <Select value={entry.resourceType} onChange={(e) => setEntry({ ...entry, resourceType: e.target.value })}>
            {options(RESOURCE_TYPES)}
          </Select>
        </Field>
        <Field label="Pattern type">
          <Select value={entry.resourcePatternType} onChange={(e) => setEntry({ ...entry, resourcePatternType: e.target.value })}>
            {options(PATTERN_TYPES, ['0', '1', '2'])}
          </Select>
        </Field>
      </div>
      <Field label="Resource name" hint="* matches every resource of that type">
        <Input className="mono" value={entry.resourceName} onChange={(e) => setEntry({ ...entry, resourceName: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Principal">
          <Input className="mono" value={entry.principal} onChange={(e) => setEntry({ ...entry, principal: e.target.value })} placeholder="User:alice" />
        </Field>
        <Field label="Host">
          <Input className="mono" value={entry.host} onChange={(e) => setEntry({ ...entry, host: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Operation">
          <Select value={entry.operation} onChange={(e) => setEntry({ ...entry, operation: e.target.value })}>
            {options(OPERATIONS)}
          </Select>
        </Field>
        <Field label="Permission">
          <Select value={entry.permissionType} onChange={(e) => setEntry({ ...entry, permissionType: e.target.value })}>
            {options(PERMISSIONS)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function AclsPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const acls = useAsync(() => api.acls(cluster.id), [cluster.id]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AclEntry | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (acls.data ?? []).filter(
      (a) => !needle || a.resourceName.toLowerCase().includes(needle) || a.principal.toLowerCase().includes(needle),
    );
  }, [acls.data, search]);

  return (
    <>
      <PageHead
        title="ACL"
        subtitle="Authorization rules stored on the cluster. Requires an authorizer to be configured on the brokers."
        actions={
          <>
            <Button onClick={acls.reload} loading={acls.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setCreating(true)}>
              <Icon.Plus width={14} /> Create ACL
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter by principal or resource…" />
      </div>

      {acls.loading && <Loading />}
      {acls.error && <ErrorBanner error={acls.error} onRetry={acls.reload} />}
      {acls.data && (
        <DataTable
          rows={rows}
          rowKey={(a) => `${a.resourceType}/${a.resourceName}/${a.principal}/${a.operation}/${a.permissionType}/${a.host}`}
          empty={
            <EmptyState
              icon={<Icon.Shield />}
              title="No ACLs found"
              description="Either no rules are defined, or the brokers run without an authorizer."
            />
          }
          columns={[
            { key: 'principal', header: 'Principal', render: (a) => <span className="mono">{a.principal}</span> },
            {
              key: 'permission',
              header: 'Permission',
              render: (a) => (
                <Badge tone={PERMISSIONS[a.permissionType] === 'ALLOW' ? 'success' : 'danger'}>
                  {PERMISSIONS[a.permissionType] ?? a.permissionType}
                </Badge>
              ),
            },
            { key: 'operation', header: 'Operation', render: (a) => <Badge tone="accent">{OPERATIONS[a.operation] ?? a.operation}</Badge> },
            { key: 'resourceType', header: 'Resource', render: (a) => <Badge>{RESOURCE_TYPES[a.resourceType] ?? a.resourceType}</Badge> },
            { key: 'resourceName', header: 'Name', render: (a) => <span className="mono">{a.resourceName}</span> },
            { key: 'pattern', header: 'Pattern', render: (a) => <span className="subtle">{PATTERN_TYPES[a.resourcePatternType] ?? a.resourcePatternType}</span> },
            { key: 'host', header: 'Host', render: (a) => <span className="mono subtle">{a.host}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (a) => (
                <div className="row-actions">
                  <Button size="sm" variant="ghost" iconOnly title="Delete" disabled={cluster.readonly} onClick={() => setDeleting(a)}>
                    <Icon.Trash width={14} />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {creating && <CreateAclModal cluster={cluster} onClose={() => setCreating(false)} onDone={acls.reload} />}
      {deleting && (
        <ConfirmDialog
          danger
          title="Delete ACL?"
          message={
            <>
              Removing <b>{PERMISSIONS[deleting.permissionType]}</b> <b>{OPERATIONS[deleting.operation]}</b> for{' '}
              <span className="mono">{deleting.principal}</span> on{' '}
              <span className="mono">{deleting.resourceName}</span>.
            </>
          }
          confirmLabel="Delete ACL"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteAcl(cluster.id, deleting);
              toast.success('ACL deleted');
              acls.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
