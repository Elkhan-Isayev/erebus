import { useState } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Badge, Button, ConfirmDialog, PageHead } from '@/components/ui';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { navigate } from '@/lib/router';
import { useAppState } from '@/app/AppState';
import { ClusterForm } from './ClusterForm';

export function ClustersPage({ openForm, onFormClosed }: { openForm?: boolean; onFormClosed?: () => void }) {
  const { clusters, reloadClusters } = useAppState();
  const toast = useToast();
  const [editing, setEditing] = useState<ClusterConfig | null | undefined>(openForm ? null : undefined);
  const [deleting, setDeleting] = useState<ClusterConfig | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const closeForm = () => {
    setEditing(undefined);
    onFormClosed?.();
  };

  const test = async (cluster: ClusterConfig) => {
    setTesting(cluster.id);
    try {
      const result = await api.testCluster(cluster.id);
      toast.success(`${cluster.name}: ${result.brokers} broker(s) online`);
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(null);
    }
  };

  const exportAll = async () => {
    try {
      const json = await api.exportClusters();
      const result = await api.saveFile('erebus-clusters.json', json);
      if (result.saved) toast.success(`Exported to ${result.path}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const importFile = async () => {
    try {
      const file = await api.openFile([{ name: 'JSON', extensions: ['json'] }]);
      if (!file.opened || !file.contents) return;
      await api.importClusters(file.contents);
      await reloadClusters();
      toast.success('Clusters imported — re-enter any secrets');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <PageHead
        title="Clusters"
        subtitle="Every cluster you connect to, with its Schema Registry, Connect and ksqlDB endpoints."
        actions={
          <>
            <Button onClick={importFile}>
              <Icon.Upload width={14} /> Import
            </Button>
            <Button onClick={exportAll} disabled={clusters.length === 0}>
              <Icon.Download width={14} /> Export
            </Button>
            <Button variant="primary" onClick={() => setEditing(null)}>
              <Icon.Plus width={14} /> Add cluster
            </Button>
          </>
        }
      />

      {clusters.length === 0 ? (
        <div className="hero">
          <Icon.Logo className="mark" width={66} height={66} />
          <h1>Connect your first cluster</h1>
          <p>
            Erebus talks straight to your brokers from this machine. Nothing leaves your laptop — configuration and
            credentials stay in your OS keychain.
          </p>
          <Button variant="primary" onClick={() => setEditing(null)}>
            <Icon.Plus width={14} /> Add cluster
          </Button>
        </div>
      ) : (
        <div className="cluster-grid">
          {clusters.map((cluster) => (
            <div key={cluster.id} className="cluster-card" onClick={() => navigate(`/c/${cluster.id}/dashboard`)}>
              <div className="card-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  title="Test connection"
                  loading={testing === cluster.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void test(cluster);
                  }}
                >
                  <Icon.Zap width={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  title="Edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(cluster);
                  }}
                >
                  <Icon.Edit width={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting(cluster);
                  }}
                >
                  <Icon.Trash width={14} />
                </Button>
              </div>
              <h3>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 5,
                    background: cluster.color ?? 'var(--accent)',
                    display: 'inline-block',
                  }}
                />
                {cluster.name}
              </h3>
              <div className="servers">
                {cluster.kind === 'rabbitmq' ? `${cluster.rabbit?.url}  ·  ${cluster.rabbit?.vhost}` : cluster.bootstrapServers}
              </div>
              <div className="foot">
                <Badge tone="accent">{cluster.kind === 'rabbitmq' ? 'RabbitMQ' : 'Kafka'}</Badge>
                {cluster.readonly && <Badge tone="warning">read-only</Badge>}
                {cluster.sasl && <Badge tone="info">{cluster.sasl.mechanism.toUpperCase()}</Badge>}
                {cluster.ssl?.enabled && <Badge tone="info">TLS</Badge>}
                {cluster.schemaRegistry?.url && <Badge>Schema Registry</Badge>}
                {(cluster.connects?.length ?? 0) > 0 && <Badge>Connect ×{cluster.connects.length}</Badge>}
                {cluster.ksqldb?.url && <Badge>ksqlDB</Badge>}
                {cluster.kind === 'rabbitmq' && <Badge>management API</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <ClusterForm
          initial={editing}
          onClose={closeForm}
          onSaved={async (saved) => {
            await reloadClusters();
            closeForm();
            navigate(`/c/${saved.id}/dashboard`);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={`Delete ${deleting.name}?`}
          message="The cluster configuration is removed from this machine. Nothing on the cluster itself is touched."
          confirmLabel="Delete cluster"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteCluster(deleting.id);
            await reloadClusters();
            toast.success('Cluster removed');
          }}
        />
      )}
    </>
  );
}
