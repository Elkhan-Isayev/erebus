import { useState } from 'react';
import type { ClusterConfig, ProduceInput } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Button, Field, Input, Modal, Segmented, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';
import { useAppState } from '@/app/AppState';

type Serde = ProduceInput['valueSerde'];
const SERDES: Serde[] = ['string', 'json', 'base64', 'avro'];

function headersToJson(headers: { key: string; value: string }[]): string {
  const shaped: Record<string, unknown> = {};
  for (const header of headers) {
    if (!header.key.trim()) continue;
    const trimmed = header.value.trim();
    let parsed: unknown = header.value;
    if (/^[[{]/.test(trimmed)) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = header.value;
      }
    }
    shaped[header.key] = parsed;
  }
  return JSON.stringify(shaped, null, 2);
}

export interface ProducePrefill {
  key?: string | null;
  value?: string | null;
  headers?: { key: string; value: string }[];
}

export function ProduceModal({
  cluster,
  topic,
  partitionCount,
  prefill,
  onClose,
  onProduced,
}: {
  cluster: ClusterConfig;
  topic: string;
  partitionCount: number;
  /** Seeds the dialog, e.g. when resending an existing message. */
  prefill?: ProducePrefill;
  onClose: () => void;
  onProduced?: () => void;
}) {
  const toast = useToast();
  const { settings } = useAppState();
  const avroSchemas = settings.avroSchemas ?? [];
  const [busy, setBusy] = useState(false);
  const [keySerde, setKeySerde] = useState<Serde>('string');
  const [valueSerde, setValueSerde] = useState<Serde>('json');
  const [key, setKey] = useState(prefill?.key ?? '');
  const [value, setValue] = useState(prefill?.value ?? '{\n  \n}');
  const [nullKey, setNullKey] = useState(prefill?.key === null);
  const [partition, setPartition] = useState<string>('');
  const [compression, setCompression] = useState<NonNullable<ProduceInput['compression']>>('none');
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>(prefill?.headers ?? []);
  const [headerMode, setHeaderMode] = useState<'pairs' | 'json'>('pairs');
  const [headerJson, setHeaderJson] = useState(() => headersToJson(prefill?.headers ?? []));
  const [keySubject, setKeySubject] = useState(`${topic}-key`);
  const [valueSubject, setValueSubject] = useState(`${topic}-value`);

  const subjects = useAsync(() => api.subjects(cluster.id), [cluster.id], {
    enabled: Boolean(cluster.schemaRegistry?.url),
  });

  /** In JSON mode the textarea is the source of truth. */
  const resolveHeaders = (): { key: string; value: string }[] => {
    if (headerMode === 'pairs') return headers.filter((h) => h.key.trim());
    const parsed = JSON.parse(headerJson || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Headers must be a JSON object of header names to values');
    }
    return Object.entries(parsed).map(([k, v]) => ({
      key: k,
      value: typeof v === 'string' ? v : JSON.stringify(v),
    }));
  };

  const send = async () => {
    let resolvedHeaders: { key: string; value: string }[];
    try {
      resolvedHeaders = resolveHeaders();
    } catch (err) {
      return toast.error(err);
    }
    setBusy(true);
    try {
      const result = await api.produce({
        clusterId: cluster.id,
        topic,
        partition: partition === '' ? null : Number(partition),
        key: nullKey ? null : key,
        value,
        headers: resolvedHeaders,
        keySerde,
        valueSerde,
        keySubject: keySerde === 'avro' ? keySubject : null,
        valueSubject: valueSerde === 'avro' ? valueSubject : null,
        compression,
      });
      const target = result[0];
      toast.success(`Produced to partition ${target?.partition} at offset ${target?.offset}`);
      onProduced?.();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const prettify = () => {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal
      wide
      title={
        <span>
          Produce to <span className="mono">{topic}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {valueSerde === 'json' && (
            <Button className="left" onClick={prettify}>
              Format JSON
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={send}>
            <Icon.Send width={14} /> Produce
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Partition" hint="Empty lets Kafka choose">
          <Select value={partition} onChange={(e) => setPartition(e.target.value)}>
            <option value="">auto</option>
            {Array.from({ length: partitionCount }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Compression">
          <Select value={compression} onChange={(e) => setCompression(e.target.value as typeof compression)}>
            <option value="none">none</option>
            <option value="gzip">gzip</option>
            <option value="lz4">lz4</option>
            <option value="snappy">snappy</option>
            <option value="zstd">zstd</option>
          </Select>
        </Field>
        <Field label="Key serde">
          <Select value={keySerde} onChange={(e) => setKeySerde(e.target.value as Serde)}>
            {SERDES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            {avroSchemas.length > 0 && (
              <optgroup label="Avro schemas">
                {avroSchemas.map((entry) => (
                  <option key={entry.id} value={`avro:${entry.id}`}>
                    avro · {entry.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label="Value serde">
          <Select value={valueSerde} onChange={(e) => setValueSerde(e.target.value as Serde)}>
            {SERDES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            {avroSchemas.length > 0 && (
              <optgroup label="Avro schemas">
                {avroSchemas.map((entry) => (
                  <option key={entry.id} value={`avro:${entry.id}`}>
                    avro · {entry.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
      </div>

      {(keySerde === 'avro' || valueSerde === 'avro') && (
        <div className="field-row">
          {keySerde === 'avro' && (
            <Field label="Key subject">
              <Input list="erebus-subjects" className="mono" value={keySubject} onChange={(e) => setKeySubject(e.target.value)} />
            </Field>
          )}
          {valueSerde === 'avro' && (
            <Field label="Value subject">
              <Input list="erebus-subjects" className="mono" value={valueSubject} onChange={(e) => setValueSubject(e.target.value)} />
            </Field>
          )}
          <datalist id="erebus-subjects">
            {(subjects.data ?? []).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      )}

      <Field
        label="Key"
        hint={
          <label className="checkbox">
            <input type="checkbox" checked={nullKey} onChange={(e) => setNullKey(e.target.checked)} />
            <span>send null key</span>
          </label>
        }
      >
        <Input className="mono" value={key} disabled={nullKey} onChange={(e) => setKey(e.target.value)} />
      </Field>

      <Field label="Value">
        <Textarea rows={12} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>

      <Field
        label="Headers"
        hint={
          headerMode === 'json'
            ? 'A JSON object: values that are objects or arrays are serialised as JSON, strings are sent as-is.'
            : undefined
        }
      >
        <div style={{ marginBottom: 8 }}>
          <Segmented<'pairs' | 'json'>
            value={headerMode}
            onChange={(mode) => {
              // Carry the current content across so switching never loses work.
              if (mode === 'json') setHeaderJson(headersToJson(headers.filter((h) => h.key.trim())));
              else {
                try {
                  const parsed = JSON.parse(headerJson || '{}') as Record<string, unknown>;
                  setHeaders(
                    Object.entries(parsed).map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v) })),
                  );
                } catch {
                  /* keep whatever pairs we had */
                }
              }
              setHeaderMode(mode);
            }}
            options={[
              { value: 'pairs', label: 'Pairs' },
              { value: 'json', label: 'JSON' },
            ]}
          />
        </div>

        {headerMode === 'json' ? (
          <Textarea rows={6} value={headerJson} onChange={(e) => setHeaderJson(e.target.value)} />
        ) : (
          <>
        {headers.map((header, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input
              className="mono"
              placeholder="header"
              value={header.key}
              onChange={(e) => setHeaders(headers.map((h, i) => (i === index ? { ...h, key: e.target.value } : h)))}
            />
            <Input
              className="mono"
              placeholder="value"
              value={header.value}
              onChange={(e) => setHeaders(headers.map((h, i) => (i === index ? { ...h, value: e.target.value } : h)))}
            />
            <Button variant="ghost" iconOnly onClick={() => setHeaders(headers.filter((_, i) => i !== index))}>
              <Icon.Trash width={14} />
            </Button>
          </div>
        ))}
        <Button size="sm" onClick={() => setHeaders([...headers, { key: '', value: '' }])}>
          <Icon.Plus width={13} /> Add header
        </Button>
          </>
        )}
      </Field>
    </Modal>
  );
}
