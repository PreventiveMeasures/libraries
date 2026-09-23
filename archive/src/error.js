// `offset` is where in the archive the reader gave up, in bytes; the
// writer leaves it unset.
export class ArchiveError extends Error {
  constructor(detail, offset) {
    super(offset === undefined ? detail : `${detail} at byte ${offset}`)
    this.name = 'ArchiveError'
    this.offset = offset
  }
}

// The same error, placed: for a check that does not know where in the
// archive it is running. Anything but such a refusal — a bug above all —
// goes on as it was, rather than dressed up as bad input.
export function located(fn, at) {
  try {
    return fn()
  } catch (error) {
    if (!(error instanceof ArchiveError) || error.offset !== undefined) throw error
    throw new ArchiveError(error.message, at)
  }
}
