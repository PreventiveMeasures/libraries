'use strict'

// The semver peer dependency by a plain require(), which a bundler follows
// and bundles: CommonJS for that alone. In an ESM bundle that leaves semver
// out, this require() is the bundler's stub, which throws.
module.exports = function requirePeer() {
  return require('semver')
}
