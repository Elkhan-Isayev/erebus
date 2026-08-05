import { useState } from 'react';
import type { ClusterConfig } from '@shared/types';
import { Icon } from '@/components/Icons';
import { Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/lib/toast';

/** Publishing to the default exchange with routing key = queue name is the "send to a queue" case. */
export function RabbitPublishModal({
  cluster,
  defaultExchange = '',
  defaultRoutingKey = '',
  onClose,
  onPublished,
}: {
  cluster: ClusterConfig;
  defaultExchange?: string;
  defaultRoutingKey?: string;
  onClose: () => void;
  onPublished?: () => void;
}) {
  const toast = useToast();
  const exchanges = useAsync(() => api.rabbitExchanges(cluster.id), [cluster.id]);
  const [exchange, setExchange] = useState(defaultExchange);
  const [routingKey, setRoutingKey] = useState(defaultRoutingKey);
  const [payload, setPayload] = useState('{\n  \n}');
  const [encoding, setEncoding] = useState<'string' | 'base64'>('string');
  const [contentType, setContentType] = useState('application/json');
  const [persistent, setPersistent] = useState(true);
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      const result = await api.rabbitPublish({
        clusterId: cluster.id,
        exchange,
        routingKey,
        payload,
        payloadEncoding: encoding,
        headers: Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key, h.value])),
        properties: { content_type: contentType, delivery_mode: persistent ? 2 : 1 },
      });
      if (result.routed) toast.success('Published and routed');
      else toast.push('Published, but no queue matched the routing key', 'error');
      onPublished?.();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="Publish message"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={send}>
            <Icon.Send width={14} /> Publish
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Exchange" hint="Empty is the default exchange — routes straight to the queue named below">
          <Select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="">(default exchange)</option>
            {(exchanges.data ?? [])
              .filter((e) => e.name)
              .map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} ({e.type})
                </option>
              ))}
          </Select>
        </Field>
        <Field label={exchange ? 'Routing key' : 'Queue name'}>
          <Input className="mono" value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} placeholder="orders.created" />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Content type">
          <Input className="mono" value={contentType} onChange={(e) => setContentType(e.target.value)} />
        </Field>
        <Field label="Payload encoding">
          <Select value={encoding} onChange={(e) => setEncoding(e.target.value as 'string' | 'base64')}>
            <option value="string">string</option>
            <option value="base64">base64</option>
          </Select>
        </Field>
        <Field label="Delivery mode">
          <Select value={persistent ? '2' : '1'} onChange={(e) => setPersistent(e.target.value === '2')}>
            <option value="2">persistent</option>
            <option value="1">transient</option>
          </Select>
        </Field>
      </div>

      <Field label="Payload">
        <Textarea rows={10} value={payload} onChange={(e) => setPayload(e.target.value)} />
      </Field>

      <Field label="Headers">
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
      </Field>
    </Modal>
  );
}
