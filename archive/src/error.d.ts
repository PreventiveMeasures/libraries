/**
 * Thrown on anything refused, by a reader or a writer
 */
export class ArchiveError extends Error {
  constructor(detail: string, offset?: number, options?: { limited?: boolean });
  /** Byte offset in the archive where a reader gave up; unset from a writer */
  offset: number | undefined;
  /** Whether a bound the caller set stopped it, rather than anything wrong with the input */
  limited: boolean;
}
