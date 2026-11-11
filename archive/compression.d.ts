/**
 * Bytes through the platform's `CompressionStream` and `DecompressionStream`, whole
 *
 * ```js
 * import { compress, decompress, supports } from '@preventive/archive/compression.js'
 * ```
 *
 * @module @preventive/archive/compression.js
 */

import { ArchiveError } from './src/error.js';

export { ArchiveError };

/**
 * Whether this runtime has a format both ways
 *
 * @param format - `'gzip'`, `'deflate'` and `'deflate-raw'` are everywhere, `'brotli'` only where added
 */
export function supports(format: string): boolean;

export interface Options {
  /** Most bytes of output; past it, rejects with `limited` set (default: no limit) */
  limit?: number;
}

/**
 * Compress bytes
 *
 * @param bytes - The input
 * @param format - A `CompressionStream` format; one the runtime lacks rejects with the platform's error
 * @param options - The output bound
 * @returns The output
 */
export function compress(bytes: Uint8Array, format: string, options?: Options): Promise<Uint8Array>;

/**
 * Decompress bytes
 *
 * gzip is read past zero bytes after its last member, as gzip(1) and zlib take them for padding and the
 * platform does not; nothing else after the end is passed over.
 *
 * @param bytes - The input
 * @param format - A `DecompressionStream` format; one the runtime lacks rejects with the platform's error
 * @param options - The output bound
 * @returns The output
 */
export function decompress(bytes: Uint8Array, format: string, options?: Options): Promise<Uint8Array>;

/**
 * What a stream refused
 */
export class CompressionError extends ArchiveError {
  constructor(detail: string, options: { bytes: Uint8Array; limited?: boolean; cause?: unknown });
  /** The output made before the failure, for a caller that keeps it as gzip(1) does */
  bytes: Uint8Array;
  /** The platform's error */
  cause: unknown;
}
