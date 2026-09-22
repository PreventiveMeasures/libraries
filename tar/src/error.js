// The one thing this package throws. Everything it refuses — an entry it
// will not write, bytes it will not read — comes back as this, with a
// message that says which promise the input broke. `offset` is where in the
// archive the reader was when it gave up, counted in bytes from the start,
// and is left unset by the writer, which has no archive to point into.

export class TarError extends Error {
  constructor(detail, offset) {
    super(offset === undefined ? detail : `${detail} at byte ${offset}`)
    this.name = 'TarError'
    this.offset = offset
  }
}
