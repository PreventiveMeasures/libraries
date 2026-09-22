// `offset` is where in the archive the reader gave up, in bytes; the
// writer leaves it unset.
export class TarError extends Error {
  constructor(detail, offset) {
    super(offset === undefined ? detail : `${detail} at byte ${offset}`)
    this.name = 'TarError'
    this.offset = offset
  }
}
