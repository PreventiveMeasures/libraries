const NOT_IMPLEMENTED = [
  'Provider `chrome` is not available in a browser build: the Prompt API exposes no way for a page to',
  'tell which on-device model answers it, so a turn cannot be cached under the model that produced it.',
  'Use a hosted provider, or ollama against a local server.',
].join(' ')

const notImplemented = () => { throw new Error(NOT_IMPLEMENTED) }

export const CHROME_ADAPTER = {
  runsLocally: true,
  preflight: notImplemented,
  send: notImplemented,
  // Not a throw: closeProvider closes EVERY adapter, so a page that never touched chrome reaches this.
  close: () => {},
}
