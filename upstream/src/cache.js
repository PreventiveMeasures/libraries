import assert from 'node:assert/strict'

// Where cached answers live on disk, which is the caller's to decide and
// nobody else's: this package has no idea what the host is or where a
// deployment wants its cache. So there is no default and no environment
// variable read here.
//
// Unset, there is no cache at all: every read misses and every write is
// skipped, so a caller that never calls setCacheDir asks the network each
// time and leaves nothing behind on disk.
let root

export function setCacheDir(dir) {
  assert.ok(typeof dir === 'string' && dir.length > 0, 'setCacheDir: expected a directory path')
  root = dir
}

export function cacheDir() {
  return root
}
