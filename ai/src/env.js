// Every environment read the layer makes, behind one function.

// Concentrated here rather than spread over the six modules that used to read `process.env`
// directly, for two reasons.

// `process` is Node's and nothing else here is. A browser build swaps this module for
// env.browser.js through the `#env` condition in package.json, and a bare `process.env` in a
// provider table is a ReferenceError there — thrown while the module is still evaluating, so the
// whole layer fails to load rather than one unset variable reading as unset.

// And the reads themselves are a list: what this layer can be configured with used to be
// discoverable only by grepping for `process.env`, which is not where a reader looks.

// Returns `undefined` for anything unset, as `process.env` does — every caller decides its own
// default at the call site, so the `||` that accepts an empty string as unset and the `??` that
// does not stay visible where the difference matters.
export function env(id) {
  return process.env[id]
}
