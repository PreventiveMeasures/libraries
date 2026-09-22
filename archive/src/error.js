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
// archive it is running.
export function located(fn, at) {
  try {
    return fn()
  } catch (error) {
    throw new ArchiveError(error.message, at)
  }
}
