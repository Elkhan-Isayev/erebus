import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClusterConfig, ConsumeProgress, KafkaMessage, SeekType, SerdeKind } from '@shared/types';
import { Icon } from '@/components/Icons';
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  EmptyState,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
} from '@/components/ui';
import { api, bridge } from '@/lib/api';
import { cx, formatBytes, formatNumber, formatTimestamp, truncate } from '@/lib/format';
import { useAppState } from '@/app/AppState';
import { useToast } from '@/lib/toast';
import { ProduceModal } from './ProduceModal';

const SERDES: SerdeKind[] = ['auto', 'string', 'json', 'avro', 'protobuf', 'base64', 'hex', 'int32', 'int64'];

function MessageDetail({ message, onClose }: { message: KafkaMessage; onClose: () => void }) {
  const render = (payload: KafkaMessage['key']) => {
    if (payload.text === null) return <span className="subtle">null</span>;
    return (
      <CodeBlock language={payload.serde.includes('json') || payload.serde === 'avro' ? 'json' : 'text'} tall>
        {payload.text}
      </CodeBlock>
    );
  };

  return (
    <Modal
      wide
      title={
        <span>
          Message <span className="mono subtle">partition {message.partition} · offset {message.offset}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <CopyButton label="Copy value" text={message.value.text ?? ''} />
          <CopyButton label="Copy as JSON" text={JSON.stringify(message, null, 2)} />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Badge tone="accent">{formatTimestamp(message.timestamp)}</Badge>
        <Badge>partition {message.partition}</Badge>
        <Badge>offset {message.offset}</Badge>
        <Badge>key: {message.key.serde}</Badge>
        <Badge>value: {message.value.serde}</Badge>
        {message.value.schemaId !== undefined && <Badge tone="info">schema #{message.value.schemaId}</Badge>}
        <Badge>{formatBytes(message.key.size + message.value.size)}</Badge>
      </div>

      {(message.key.error || message.value.error) && (
        <div className="warn-banner">
          <Icon.Alert width={16} />
          <div>{message.key.error ?? message.value.error}</div>
        </div>
      )}

      <div className="msg-detail">
        <div>
          <h3 style={{ fontSize: 12, marginBottom: 6 }} className="subtle">
            KEY
          </h3>
          {render(message.key)}
        </div>
        <div>
          <h3 style={{ fontSize: 12, marginBottom: 6 }} className="subtle">
            VALUE
          </h3>
          {render(message.value)}
        </div>
      </div>

      {message.headers.length > 0 && (
        <>
          <h3 style={{ fontSize: 12, margin: '16px 0 6px' }} className="subtle">
            HEADERS
          </h3>
          <div className="table-wrap card">
            <table className="data">
              <tbody>
                {message.headers.map((h, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ width: '32%' }}>
                      {h.key}
                    </td>
                    <td className="mono">{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

export function MessagesView({ cluster, topic, partitionCount }: { cluster: ClusterConfig; topic: string; partitionCount: number }) {
  const { settings } = useAppState();
  const toast = useToast();

  const [seek, setSeek] = useState<SeekType>('latest');
  const [seekTo, setSeekTo] = useState('');
  const [limit, setLimit] = useState(settings.defaultMessageLimit);
  const [keySerde, setKeySerde] = useState<SerdeKind>('auto');
  const [valueSerde, setValueSerde] = useState<SerdeKind>('auto');
  const [search, setSearch] = useState('');
  const [filterExpression, setFilterExpression] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [partitionInput, setPartitionInput] = useState('');
  const [live, setLive] = useState(false);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');

  const [messages, setMessages] = useState<KafkaMessage[]>([]);
  const [progress, setProgress] = useState<ConsumeProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<KafkaMessage | null>(null);
  const [producing, setProducing] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const bufferLimit = live ? settings.liveTailBuffer : Math.max(limit, 1);

  useEffect(() => {
    const offData = bridge.on('consume:messages', (payload) => {
      const data = payload as { sessionId: string; messages: KafkaMessage[] };
      if (data.sessionId !== sessionRef.current) return;
      setMessages((prev) => {
        const next = [...prev, ...data.messages];
        return next.length > bufferLimit ? next.slice(next.length - bufferLimit) : next;
      });
    });
    const offProgress = bridge.on('consume:progress', (payload) => {
      const data = payload as ConsumeProgress;
      if (data.sessionId !== sessionRef.current) return;
      setProgress(data);
      if (data.done) {
        setRunning(false);
        sessionRef.current = null;
        if (data.error) toast.error(data.error);
      }
    });
    return () => {
      offData();
      offProgress();
    };
  }, [bufferLimit, toast]);

  const stop = useCallback(async () => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    await api.stopConsume(sessionId).catch(() => undefined);
    sessionRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => {
    return () => {
      const sessionId = sessionRef.current;
      if (sessionId) void api.stopConsume(sessionId).catch(() => undefined);
    };
  }, []);

  const start = useCallback(
    async (options: { live?: boolean } = {}) => {
      await stop();
      const isLive = options.live ?? live;
      const sessionId = crypto.randomUUID();
      sessionRef.current = sessionId;
      setMessages([]);
      setProgress(null);
      setRunning(true);
      try {
        const partitions = partitionInput
          .split(',')
          .map((p) => Number(p.trim()))
          .filter((p) => Number.isInteger(p) && p >= 0);
        await api.consume({
          clusterId: cluster.id,
          topic,
          partitions: partitions.length ? partitions : undefined,
          seek,
          seekTo: seekTo || undefined,
          limit,
          search: search.trim() || undefined,
          filterExpression: showFilter && filterExpression.trim() ? filterExpression : undefined,
          keySerde,
          valueSerde,
          live: isLive,
          sessionId,
        });
      } catch (err) {
        sessionRef.current = null;
        setRunning(false);
        toast.error(err);
      }
    },
    [cluster.id, topic, partitionInput, seek, seekTo, limit, search, showFilter, filterExpression, keySerde, valueSerde, live, stop, toast],
  );

  useEffect(() => {
    void start({ live: false });
    // Load the newest page as soon as the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster.id, topic]);

  const toggleLive = async () => {
    if (live) {
      await stop();
      setLive(false);
      return;
    }
    setLive(true);
    setSeek('latest');
    await start({ live: true });
  };

  const sorted = useMemo(() => {
    const rows = [...messages];
    rows.sort((a, b) => {
      const diff = Number(a.timestamp) - Number(b.timestamp) || a.partition - b.partition || Number(a.offset) - Number(b.offset);
      return order === 'asc' ? diff : -diff;
    });
    return rows;
  }, [messages, order]);

  const exportMessages = async () => {
    try {
      const result = await api.saveFile(`${topic}-messages.json`, JSON.stringify(sorted, null, 2));
      if (result.saved) toast.success(`Saved ${sorted.length} messages`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="messages-layout">
      <div className="messages-toolbar">
        <Field label="Seek">
          <Select value={seek} onChange={(e) => setSeek(e.target.value as SeekType)} disabled={live}>
            <option value="latest">Newest first</option>
            <option value="earliest">Oldest first</option>
            <option value="offset">From offset</option>
            <option value="timestamp">From timestamp</option>
          </Select>
        </Field>

        {(seek === 'offset' || seek === 'timestamp') && (
          <Field label={seek === 'offset' ? 'Offset' : 'Timestamp'}>
            {seek === 'offset' ? (
              <Input className="mono" style={{ width: 120 }} value={seekTo} onChange={(e) => setSeekTo(e.target.value)} placeholder="0" />
            ) : (
              <Input
                type="datetime-local"
                style={{ width: 210 }}
                onChange={(e) => setSeekTo(e.target.value ? String(new Date(e.target.value).getTime()) : '')}
              />
            )}
          </Field>
        )}

        <Field label="Partitions">
          <Input
            className="mono"
            style={{ width: 110 }}
            placeholder={`all (${partitionCount})`}
            value={partitionInput}
            onChange={(e) => setPartitionInput(e.target.value)}
          />
        </Field>

        <Field label="Limit">
          <Input
            type="number"
            style={{ width: 88 }}
            min={1}
            value={limit}
            disabled={live}
            onChange={(e) => setLimit(Math.max(1, Number(e.target.value)))}
          />
        </Field>

        <Field label="Key">
          <Select value={keySerde} onChange={(e) => setKeySerde(e.target.value as SerdeKind)} style={{ width: 108 }}>
            {SERDES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Value">
          <Select value={valueSerde} onChange={(e) => setValueSerde(e.target.value as SerdeKind)} style={{ width: 108 }}>
            {SERDES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Contains" className="grow">
          <Input
            style={{ minWidth: 150 }}
            placeholder="substring in key, value or headers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
          />
        </Field>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {running ? (
            <Button variant="danger" onClick={() => void stop()}>
              <Icon.Stop width={14} /> Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void start({ live: false })}>
              <Icon.Play width={14} /> Fetch
            </Button>
          )}
          <Button variant={live ? 'danger' : 'default'} onClick={() => void toggleLive()} title="Tail new messages">
            {live ? <span className="live-dot" /> : <Icon.Zap width={14} />}
            {live ? 'Live' : 'Live tail'}
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Advanced filter"
            className={cx(showFilter && 'primary')}
            onClick={() => setShowFilter((v) => !v)}
          >
            <Icon.Filter width={15} />
          </Button>
          <Button variant="ghost" iconOnly title="Produce message" disabled={cluster.readonly} onClick={() => setProducing(true)}>
            <Icon.Send width={15} />
          </Button>
        </div>
      </div>

      {showFilter && (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <Field
            label="JavaScript filter"
            hint="Runs per message in a sandbox. Available: key, value (parsed when JSON), headers, message."
          >
            <Input
              className="mono"
              placeholder="value.status === 'FAILED' && headers['source'] === 'api'"
              value={filterExpression}
              onChange={(e) => setFilterExpression(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void start()}
            />
          </Field>
        </div>
      )}

      <div className="messages-status">
        {running && <span className="spinner" />}
        <span>
          <b>{formatNumber(messages.length)}</b> shown
        </span>
        {progress && (
          <>
            <span className="subtle">·</span>
            <span>{formatNumber(progress.scanned)} scanned</span>
            <span className="subtle">·</span>
            <span>{(progress.elapsedMs / 1000).toFixed(1)}s</span>
          </>
        )}
        {live && (
          <>
            <span className="subtle">·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="live-dot" /> tailing, keeping last {settings.liveTailBuffer}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Segmented
          value={order}
          onChange={setOrder}
          options={[
            { value: 'desc', label: 'Newest' },
            { value: 'asc', label: 'Oldest' },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={exportMessages} disabled={messages.length === 0}>
          <Icon.Download width={13} /> Export
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMessages([])} disabled={messages.length === 0}>
          Clear
        </Button>
      </div>

      <div className="messages-body">
        {sorted.length === 0 ? (
          <EmptyState
            icon={<Icon.Inbox />}
            title={running ? 'Waiting for messages…' : 'No messages matched'}
            description={
              running
                ? 'Erebus is scanning the requested offsets.'
                : 'Try a wider seek position, a larger limit, or clear the filters.'
            }
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 176 }}>Timestamp</th>
                <th style={{ width: 60 }}>Part.</th>
                <th style={{ width: 96 }}>Offset</th>
                <th style={{ width: '28%' }}>Key</th>
                <th>Value</th>
                <th style={{ width: 70 }} className="right">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((message) => (
                <tr key={`${message.partition}-${message.offset}`} className="msg-row clickable" onClick={() => setSelected(message)}>
                  <td className="mono subtle">{formatTimestamp(message.timestamp)}</td>
                  <td className="mono">{message.partition}</td>
                  <td className="mono">{message.offset}</td>
                  <td>
                    <div className="msg-preview">
                      {message.key.text === null ? <span className="subtle">null</span> : truncate(message.key.text, 160)}
                    </div>
                  </td>
                  <td>
                    <div className="msg-preview">
                      {message.value.text === null ? <span className="subtle">null</span> : truncate(message.value.text, 400)}
                    </div>
                  </td>
                  <td className="right mono subtle">{formatBytes(message.key.size + message.value.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <MessageDetail message={selected} onClose={() => setSelected(null)} />}
      {producing && (
        <ProduceModal
          cluster={cluster}
          topic={topic}
          partitionCount={partitionCount}
          onClose={() => setProducing(false)}
          onProduced={() => void start({ live })}
        />
      )}
    </div>
  );
}
