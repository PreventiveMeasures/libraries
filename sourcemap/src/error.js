// What readSourceMap throws for a map it cannot read: not JSON, not version
// 3, or a field that is not what the format says it is. A map is read whole
// or not at all, so a caller never holds half of one.
export class SourceMapError extends Error {
  name = 'SourceMapError'
}
