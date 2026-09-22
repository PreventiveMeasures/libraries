// The compression front door of @preventive/archive, reached as
// `@preventive/archive/compression.js`: bytes through the platform's
// CompressionStream and DecompressionStream, whole, with an output bound,
// and with what came out before a failure kept on the error. The zip half
// deflates through the same code.
export { CompressionError, compress, decompress, supports } from './src/compression.js'
export { ArchiveError } from './src/error.js'
