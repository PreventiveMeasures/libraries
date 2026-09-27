import assert from 'node:assert/strict'

import { valid } from '../semver.js'

// The public registry, and the names and versions it takes: shared by
// every lookup in src/npm/.
export const REGISTRY = 'https://registry.npmjs.org'

// Same shape npm itself validates names against.
const packageNameRegex = /^(@[\da-z-]+\/)?[\w-]+(\.[\w-]+)*$/u

// Asserted before any request to the registry, metadata included: both
// are spliced into a URL path as they stand, so neither may be anything
// but a string of the shape the registry files packages under. A version
// has to be one npm's semver takes AND spell it the way semver does —
// `v1.2.3` or `1.2.3+build` pass `semver.valid` but are not the version
// the registry files, and a space or a `/` in one would change the path.
export function assertPackageName(name) {
  assert.ok(typeof name === 'string' && packageNameRegex.test(name), `Unexpected package name: ${name}`)
}

export function assertPackageVersion(version) {
  assert.ok(typeof version === 'string' && valid(version) === version, `Unexpected package version: ${version}`)
}
