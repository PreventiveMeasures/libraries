// env.js for a browser build, swapped in by the `#env` condition in package.json.

// A stub: everything reads as unset. `process` does not exist here, and there is no browser
// equivalent to fall back to — a page has no ambient environment, and the values these ids name are
// API keys and endpoints a page would have to be GIVEN rather than find lying around.

// So the browser build is configured through the layer's own setters (setProvider, setCacheDir,
// setFetchConcurrency) and not through this, and returning `undefined` is the honest answer rather
// than a placeholder: a caller that needs a key gets `Missing API key for <provider>` out of
// setProvider's preflight, which is the same message an unset variable produces under Node.
export function env() {
  return undefined
}
