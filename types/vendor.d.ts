declare module 'lz4js' {
  export function compress(data: Uint8Array | Buffer): Uint8Array;
  export function decompress(data: Uint8Array | Buffer): Uint8Array;
}
declare module 'kafkajs-snappy' {
  const codec: () => { compress(encoder: { buffer: Buffer }): Promise<Buffer>; decompress(buffer: Buffer): Promise<Buffer> };
  export default codec;
}

declare module 'lz4js/xxh32.js' {
  const xxh32: { hash(seed: number, buffer: Uint8Array, index: number, length: number): number };
  export default xxh32;
}
