import { useState } from 'react';
import type { ClusterConfig, KsqlResponse } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Button, CodeBlock, EmptyState, ErrorBanner, PageHead, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';

const SAMPLES = [
  'SHOW STREAMS;',
  'SHOW TABLES;',
  'SHOW QUERIES;',
  'SHOW TOPICS;',
  'DESCRIBE <stream> EXTENDED;',
  'SELECT * FROM <stream> EMIT CHANGES LIMIT 10;',
];

function ResultTable({ result }: { result: KsqlResponse }) {
  if (result.rows.length === 0) {
    return <CodeBlock language="json">{JSON.stringify(result.raw, null, 2)}</CodeBlock>;
  }
  return (
    <div className="table-wrap card">
      <table className="data">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="mono" style={{ maxWidth: 380, wordBreak: 'break-word' }}>
                  {cell === null || cell === undefined
                    ? '—'
                    : typeof cell === 'object'
                      ? JSON.stringify(cell)
                      : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KsqlPage({ cluster }: { cluster: ClusterConfig }) {
  const toast = useToast();
  const configured = Boolean(cluster.ksqldb?.url);
  const [sql, setSql] = useState('SHOW STREAMS;');
  const [result, setResult] = useState<KsqlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'table' | 'raw'>('table');

  const run = async (statement = sql) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.ksql(cluster.id, statement);
      setResult(response);
      setTab('table');
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  if (!configured) {
    return (
      <EmptyState
        icon={<Icon.Terminal />}
        title="ksqlDB is not configured"
        description="Add a ksqlDB server URL in the cluster settings to run statements and browse streams and tables."
      />
    );
  }

  return (
    <>
      <PageHead
        title="ksqlDB"
        subtitle={cluster.ksqldb?.url}
        actions={
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                const info = await api.ksqlInfo(cluster.id);
                toast.push(JSON.stringify(info));
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <Icon.Info width={14} /> Server info
          </Button>
        }
      />

      <div className="toolbar">
        {SAMPLES.map((sample) => (
          <Button key={sample} size="sm" variant="ghost" onClick={() => setSql(sample)}>
            <span className="mono">{sample}</span>
          </Button>
        ))}
      </div>

      <textarea
        className="textarea"
        rows={6}
        value={sql}
        spellCheck={false}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run();
        }}
      />

      <div className="toolbar" style={{ marginTop: 10 }}>
        <Button variant="primary" loading={busy} onClick={() => void run()}>
          <Icon.Play width={14} /> Execute
          <span className="subtle" style={{ marginLeft: 4 }}>
            ⌘↵
          </span>
        </Button>
        {result && (
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'table', label: 'Result' },
              { id: 'raw', label: 'Raw' },
            ]}
          />
        )}
      </div>

      {error && <ErrorBanner error={error} />}
      {result && (tab === 'table' ? <ResultTable result={result} /> : <CodeBlock language="json" tall>{JSON.stringify(result.raw, null, 2)}</CodeBlock>)}
      {!result && !error && !busy && (
        <EmptyState icon={<Icon.Terminal />} title="Run a statement" description="SHOW, DESCRIBE, CREATE, DROP and SELECT are all supported." />
      )}
    </>
  );
}
