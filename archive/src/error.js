export class ArchiveError extends Error {
  constructor(detail, offset, { limited = false } = {}) {
    super(offset === undefined ? detail : `${detail} at byte ${offset}`)
    this.name = 'ArchiveError'
    this.offset = offset // where a reader gave up, unset from a writer
    this.limited = limited // a bound the caller set, not bad input
  }
}

// Places a refusal from a check that does not know where in the archive it runs.
// Anything else, a bug above all, is rethrown as is rather than dressed up as bad input.
export function located(fn, at) {
  try {
    return fn()
  } catch (error) {
    if (!(error instanceof ArchiveError) || error.offset !== undefined) throw error
    throw new ArchiveError(error.message, at, { limited: error.limited })
  }
}
