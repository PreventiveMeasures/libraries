// `offset` is where in the archive the reader gave up, in bytes; the
// writer leaves it unset.
export class ArchiveError extends Error {
  constructor(detail, offset) {
    super(offset === undefined ? detail : `${detail} at byte ${offset}`)
    this.name = 'ArchiveError'
    this.offset = offset
  }
}
