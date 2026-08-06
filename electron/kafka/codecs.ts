/**
 * Compression codecs for kafkajs.
 *
 * kafkajs ships GZIP only; every other codec is a plug-in you have to register, and until
 * you do, a topic written with Snappy simply returns nothing but "Snappy compression not
 * implemented" — no messages, no obvious cause. Snappy in particular is what most brokers
 * are configured with, so this is table stakes rather than an extra.
 *
 * All three implementations here are pure JavaScript or WebAssembly: Erebus stays free of
 * native modules, which is what keeps one build working on every platform and architecture.
 */
import { CompressionCodecs, CompressionTypes } from 'kafkajs';
import SnappyCodec from 'kafkajs-snappy';
import * as lz4 from 'lz4js';
import xxh32 from 'lz4js/xxh32.js';
import { compress as zstdCompress, decompress as zstdDecompress, init as zstdInit } from '@bokuweb/zstd-wasm';

/** kafkajs hands the encoder in on compress and raw bytes on decompress. */
interface Encoder {
  buffer: Buffer;
}

/**
 * Kafka reads LZ4 frames with its own decoder, and that decoder refuses linked blocks —
 * which is exactly what lz4js writes: the block-independence bit in FLG is left at zero.
 * A frame holding a single block is independent either way, so the bit is corrected and
 * the header checksum recomputed. Anything larger than one block would need real
 * per-block compression, and Kafka's own message limit makes that unreachable in practice.
 */
const LZ4_MAGIC = 0x184d2204;
const FLG_BLOCK_INDEPENDENCE = 0x20;
const HEADER_SIZE = 7; // magic(4) + FLG(1) + BD(1) + HC(1)

function countBlocks(frame: Buffer): number {
  let offset = HEADER_SIZE;
  let blocks = 0;
  while (offset + 4 <= frame.length) {
    const raw = frame.readUInt32LE(offset);
    if (raw === 0) break; // end mark
    offset += 4 + (raw & 0x7fffffff);
    blocks++;
  }
  return blocks;
}

function toKafkaFrame(frame: Buffer): Buffer {
  if (frame.length < HEADER_SIZE || frame.readUInt32LE(0) !== LZ4_MAGIC) return frame;
  if ((frame[4] & FLG_BLOCK_INDEPENDENCE) !== 0) return frame;
  if (countBlocks(frame) > 1) {
    throw new Error('This payload is too large for Erebus to compress with LZ4 — use gzip, snappy or zstd');
  }
  const out = Buffer.from(frame);
  out[4] |= FLG_BLOCK_INDEPENDENCE;
  // The header checksum covers FLG and BD; xxh32 here takes an explicit offset and length.
  out[6] = (xxh32.hash(0, out, 4, 2) >> 8) & 0xff;
  return out;
}

const LZ4Codec = () => ({
  async compress(encoder: Encoder): Promise<Buffer> {
    return toKafkaFrame(Buffer.from(lz4.compress(encoder.buffer)));
  },
  async decompress(buffer: Buffer): Promise<Buffer> {
    return Buffer.from(lz4.decompress(buffer));
  },
});

// The zstd module compiles its WebAssembly once, on first use.
let zstdReady: Promise<void> | null = null;
const ensureZstd = () => (zstdReady ??= zstdInit());

const ZstdCodec = () => ({
  async compress(encoder: Encoder): Promise<Buffer> {
    await ensureZstd();
    return Buffer.from(zstdCompress(encoder.buffer, 3));
  },
  async decompress(buffer: Buffer): Promise<Buffer> {
    await ensureZstd();
    return Buffer.from(zstdDecompress(buffer));
  },
});

CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec;
CompressionCodecs[CompressionTypes.LZ4] = LZ4Codec;
CompressionCodecs[CompressionTypes.ZSTD] = ZstdCodec;

export const SUPPORTED_COMPRESSION = ['none', 'gzip', 'snappy', 'lz4', 'zstd'] as const;
