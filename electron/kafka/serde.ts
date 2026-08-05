import avro from 'avsc';
import type { DecodedPayload, SerdeKind } from '../../shared/types';
import { hasRegistry, registerSchema, schemaById, getVersion } from '../rest/schemaRegistry';

/** Confluent wire format: magic byte 0x00 + big-endian schema id + payload. */
const MAGIC = 0x00;

function looksLikeWireFormat(buf: Buffer): boolean {
  return buf.length >= 5 && buf[0] === MAGIC;
}

function isMostlyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) suspicious++;
  }
  return suspicious / Math.max(sample.length, 1) < 0.05;
}

function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{"\-\d]|^(true|false|null)$/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

const avroTypeCache = new Map<string, avro.Type>();

function avroType(schema: string): avro.Type {
  let type = avroTypeCache.get(schema);
  if (!type) {
    type = avro.Type.forSchema(JSON.parse(schema), { wrapUnions: false });
    avroTypeCache.set(schema, type);
  }
  return type;
}

async function decodeWireFormat(clusterId: string, buf: Buffer): Promise<DecodedPayload> {
  const schemaId = buf.readInt32BE(1);
  const body = buf.subarray(5);
  if (!hasRegistry(clusterId)) {
    return {
      text: body.toString('base64'),
      serde: 'base64',
      schemaId,
      size: buf.length,
      error: `Payload carries schema id ${schemaId} but no Schema Registry is configured for this cluster`,
    };
  }
  try {
    const { schema, schemaType } = await schemaById(clusterId, schemaId);
    if (schemaType === 'AVRO') {
      const decoded = avroType(schema).fromBuffer(body);
      return { text: JSON.stringify(decoded, jsonSafe, 2), serde: 'avro', schemaId, size: buf.length };
    }
    if (schemaType === 'JSON') {
      return { text: prettyJson(body.toString('utf8')) ?? body.toString('utf8'), serde: 'json-schema', schemaId, size: buf.length };
    }
    // PROTOBUF and anything else: the message index header makes a raw render the honest option.
    return {
      text: body.toString('base64'),
      serde: schemaType.toLowerCase(),
      schemaId,
      size: buf.length,
      error: `${schemaType} payloads are shown raw — Erebus decodes Avro and JSON Schema`,
    };
  } catch (err) {
    return {
      text: body.toString('base64'),
      serde: 'base64',
      schemaId,
      size: buf.length,
      error: `Schema ${schemaId}: ${(err as Error).message}`,
    };
  }
}

function jsonSafe(_key: string, value: unknown) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

export async function decode(clusterId: string, buf: Buffer | null, serde: SerdeKind): Promise<DecodedPayload> {
  if (buf === null || buf === undefined) return { text: null, serde: 'null', size: 0 };
  const size = buf.length;
  if (size === 0) return { text: '', serde: 'empty', size };

  try {
    switch (serde) {
      case 'string':
        return { text: buf.toString('utf8'), serde: 'string', size };
      case 'json': {
        const text = buf.toString('utf8');
        return { text: prettyJson(text) ?? text, serde: 'json', size };
      }
      case 'base64':
        return { text: buf.toString('base64'), serde: 'base64', size };
      case 'hex':
        return { text: buf.toString('hex'), serde: 'hex', size };
      case 'int32':
        return { text: size >= 4 ? String(buf.readInt32BE(0)) : buf.toString('hex'), serde: 'int32', size };
      case 'int64':
        return { text: size >= 8 ? String(buf.readBigInt64BE(0)) : buf.toString('hex'), serde: 'int64', size };
      case 'avro':
      case 'protobuf':
        return looksLikeWireFormat(buf)
          ? await decodeWireFormat(clusterId, buf)
          : { text: buf.toString('base64'), serde: 'base64', size, error: 'Payload is not in Confluent wire format' };
      case 'auto':
      default: {
        if (looksLikeWireFormat(buf)) return await decodeWireFormat(clusterId, buf);
        if (isMostlyText(buf)) {
          const text = buf.toString('utf8');
          const json = prettyJson(text);
          return json ? { text: json, serde: 'json', size } : { text, serde: 'string', size };
        }
        if (size === 4) return { text: String(buf.readInt32BE(0)), serde: 'int32', size };
        if (size === 8) return { text: String(buf.readBigInt64BE(0)), serde: 'int64', size };
        return { text: buf.toString('base64'), serde: 'base64', size };
      }
    }
  } catch (err) {
    return { text: buf.toString('base64'), serde: 'base64', size, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ encode */

export async function encode(
  clusterId: string,
  input: string | null | undefined,
  serde: 'string' | 'json' | 'base64' | 'avro',
  subject?: string | null,
): Promise<Buffer | null> {
  if (input === null || input === undefined) return null;
  switch (serde) {
    case 'base64':
      return Buffer.from(input, 'base64');
    case 'json':
      // Validate, then send compact JSON.
      return Buffer.from(JSON.stringify(JSON.parse(input)), 'utf8');
    case 'avro': {
      if (!subject) throw new Error('An Avro subject is required to serialise this payload');
      const version = await getVersion(clusterId, subject, 'latest');
      if (version.schemaType !== 'AVRO') throw new Error(`Subject ${subject} is ${version.schemaType}, not AVRO`);
      const body = avroType(version.schema).toBuffer(JSON.parse(input));
      const header = Buffer.alloc(5);
      header.writeUInt8(MAGIC, 0);
      header.writeInt32BE(version.id, 1);
      return Buffer.concat([header, body]);
    }
    case 'string':
    default:
      return Buffer.from(input, 'utf8');
  }
}

/** Exposed so the UI can validate a schema before registering it. */
export function validateAvroSchema(schema: string): { valid: boolean; error?: string } {
  try {
    avro.Type.forSchema(JSON.parse(schema));
    return { valid: true };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

export { registerSchema };
