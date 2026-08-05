import { useMemo, useState } from 'react';
import type { ClusterConfig, SchemaVersion } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
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
  Tabs,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

const COMPATIBILITY_LEVELS = ['BACKWARD', 'BACKWARD_TRANSITIVE', 'FORWARD', 'FORWARD_TRANSITIVE', 'FULL', 'FULL_TRANSITIVE', 'NONE'];

function SchemaDetail({ cluster, subject, onClose, onChanged }: { cluster: ClusterConfig; subject: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const versions = useAsync(() => api.subjectVersions(cluster.id, subject), [cluster.id, subject]);
  const [version, setVersion] = useState<number | 'latest'>('latest');
  const schema = useAsync<SchemaVersion>(() => api.schema(cluster.id, subject, version), [cluster.id, subject, version]);
  const [deletingVersion, setDeletingVersion] = useState<number | null>(null);

  const pretty = useMemo(() => {
    if (!schema.data) return '';
    try {
      return JSON.stringify(JSON.parse(schema.data.schema), null, 2);
    } catch {
      return schema.data.schema;
    }
  }, [schema.data]);

  return (
    <Modal
      wide
      title={
        <span>
          Subject <span className="mono">{subject}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <CopyButton label="Copy schema" text={pretty} />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="toolbar">
        <Field label="Version">
          <Select value={String(version)} onChange={(e) => setVersion(e.target.value === 'latest' ? 'latest' : Number(e.target.value))}>
            <option value="latest">latest</option>
            {(versions.data ?? []).map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </Select>
        </Field>
        {schema.data && (
          <Field label="Compatibility">
            <Select
              value={(schema.data.compatibility ?? '').replace(' (global)', '') || 'BACKWARD'}
              onChange={async (e) => {
                try {
                  await api.setCompatibility(cluster.id, subject, e.target.value);
                  toast.success('Compatibility updated');
                  schema.reload();
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              {COMPATIBILITY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div style={{ flex: 1 }} />
        {schema.data && (
          <Button variant="danger" size="sm" onClick={() => setDeletingVersion(schema.data!.version)}>
            <Icon.Trash width={13} /> Delete version
          </Button>
        )}
      </div>

      {schema.loading && <Loading />}
      {schema.error && <ErrorBanner error={schema.error} onRetry={schema.reload} />}
      {schema.data && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Badge tone="accent">{schema.data.schemaType}</Badge>
            <Badge>version {schema.data.version}</Badge>
            <Badge>id {schema.data.id}</Badge>
            {schema.data.compatibility && <Badge tone="info">{schema.data.compatibility}</Badge>}
          </div>
          <CodeBlock language="json" tall>
            {pretty}
          </CodeBlock>
        </>
      )}

      {deletingVersion !== null && (
        <ConfirmDialog
          danger
          title={`Delete version ${deletingVersion}?`}
          message="Consumers still reading messages serialised with this schema will fail to decode them."
          confirmLabel="Delete version"
          onClose={() => setDeletingVersion(null)}
          onConfirm={async () => {
            try {
              await api.deleteSchemaVersion(cluster.id, subject, deletingVersion);
              toast.success('Version deleted');
              versions.reload();
              schema.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </Modal>
  );
}

function RegisterSchemaModal({ cluster, onClose, onDone }: { cluster: ClusterConfig; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [schemaType, setSchemaType] = useState<SchemaVersion['schemaType']>('AVRO');
  const [schema, setSchema] = useState(
    JSON.stringify(
      { type: 'record', name: 'Example', fields: [{ name: 'id', type: 'string' }] },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'schema' | 'check'>('schema');
  const [checkResult, setCheckResult] = useState<string | null>(null);

  return (
    <Modal
      wide
      title="Register schema"
      onClose={onClose}
      footer={
        <>
          <Button
            className="left"
            onClick={async () => {
              try {
                const result = await api.checkCompatibility(cluster.id, subject, schema, schemaType);
                setTab('check');
                setCheckResult(result.is_compatible ? 'Compatible with the latest version.' : 'NOT compatible with the latest version.');
              } catch (err) {
                setTab('check');
                setCheckResult((err as Error).message);
              }
            }}
            disabled={!subject}
          >
            Check compatibility
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!subject.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.registerSchema(cluster.id, subject.trim(), schema, schemaType);
                toast.success(`Registered with id ${result.id}`);
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Register
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Subject" hint="Convention: <topic>-value or <topic>-key">
          <Input className="mono" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="orders.v1-value" />
        </Field>
        <Field label="Type">
          <Select value={schemaType} onChange={(e) => setSchemaType(e.target.value as SchemaVersion['schemaType'])}>
            <option value="AVRO">AVRO</option>
            <option value="JSON">JSON</option>
            <option value="PROTOBUF">PROTOBUF</option>
          </Select>
        </Field>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'schema', label: 'Schema' },
          { id: 'check', label: 'Compatibility' },
        ]}
      />

      {tab === 'schema' ? (
        <textarea className="textarea" rows={16} value={schema} onChange={(e) => setSchema(e.target.value)} spellCheck={false} />
      ) : (
        <CodeBlock>{checkResult ?? 'Run “Check compatibility” to test this schema against the latest registered version.'}</CodeBlock>
      )}
    </Modal>
  );
}

export function SchemasPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const configured = Boolean(cluster.schemaRegistry?.url);
  const subjects = useAsync(() => api.subjects(cluster.id), [cluster.id], { enabled: configured });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const rows = useMemo(
    () => (subjects.data ?? []).filter((s) => s.toLowerCase().includes(search.toLowerCase())).map((name) => ({ name })),
    [subjects.data, search],
  );

  if (!configured) {
    return (
      <EmptyState
        icon={<Icon.Schema />}
        title="Schema Registry is not configured"
        description="Add a Schema Registry URL in the cluster settings to browse subjects, versions and compatibility."
      />
    );
  }

  return (
    <>
      <PageHead
        title="Schema Registry"
        subtitle={cluster.schemaRegistry?.url}
        actions={
          <>
            <Button onClick={subjects.reload} loading={subjects.refreshing}>
              <Icon.Refresh width={14} /> Refresh
            </Button>
            <Button variant="primary" disabled={cluster.readonly} onClick={() => setRegistering(true)}>
              <Icon.Plus width={14} /> Register schema
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter subjects…" />
      </div>

      {subjects.loading && <Loading />}
      {subjects.error && <ErrorBanner error={subjects.error} onRetry={subjects.reload} />}
      {subjects.data && (
        <DataTable
          rows={rows}
          rowKey={(s) => s.name}
          onRowClick={(s) => setSelected(s.name)}
          empty={<EmptyState icon={<Icon.Schema />} title="No subjects registered" />}
          columns={[
            { key: 'name', header: 'Subject', render: (s) => <span className="mono link-cell">{s.name}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (s) => (
                <div className="row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    title="Delete subject"
                    disabled={cluster.readonly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(s.name);
                    }}
                  >
                    <Icon.Trash width={14} />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {selected && (
        <SchemaDetail cluster={cluster} subject={selected} onClose={() => setSelected(null)} onChanged={subjects.reload} />
      )}
      {registering && <RegisterSchemaModal cluster={cluster} onClose={() => setRegistering(false)} onDone={subjects.reload} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete subject ${deleting}?`}
          requireText={deleting}
          message="Every version of this subject is soft-deleted from the registry."
          confirmLabel="Delete subject"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteSubject(cluster.id, deleting);
              toast.success('Subject deleted');
              subjects.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
    </>
  );
}
