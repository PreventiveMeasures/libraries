// chrome/index.js for a browser build, swapped in by the `#chrome` condition in package.json.

// A stub for now. The rest of chrome/ drives Chrome from OUTSIDE it — playwright launches a browser
// against a scratch profile with the model grafted in, and talks to the page over CDP — and none of
// that is a thing a page can do to itself. What a page has instead is the Prompt API directly, as
// the `LanguageModel` global, which is the same model reached without the browser in between.

// So this file is where that lands, and it is not a matter of calling `LanguageModel.create()`:
// which engine answers has to be established first. Chrome exposes the API for more than one — the
// on-device model, and a cloud fallback on some channels — and `availability()` says only whether a
// session can be created, not by what. The Node path settles this by grafting known weights into a
// profile and reading the version back out of the model directory, which is why its turns are
// priced at zero and cached under a version. A page has to establish the same thing from inside,
// and answering a chrome/* model id with a silently different engine would mis-price the turn and
// poison the cache entry under an id that promises local weights.

// Until that check exists, selecting the provider fails at selection rather than mid-run.
const NOT_IMPLEMENTED = [
  'Provider `chrome` is not available in a browser build yet: the Prompt API is reached as the',
  '`LanguageModel` global here, and which engine answers it has to be established before a turn can',
  'be priced or cached. Use a hosted provider, or ollama against a local server.',
].join(' ')

const notImplemented = () => { throw new Error(NOT_IMPLEMENTED) }

// The same single name index.js exports, so providers.js is identical on both builds.

// Only three of the four entries carry anything. `preflight` runs at setProvider and throws, so
// `send` and every method CHROME_SHAPE would have supplied is unreachable — the entry is never
// selected, and nothing reads a provider that was not. `send` is here anyway because a stub whose
// only guard is somewhere else is one refactor from being silent.

// `close` is the exception that must NOT throw: closeProvider closes EVERY adapter rather than the
// selected one, so a caller ending a run reaches this on a page that never touched chrome. Nothing
// is held open here, so there is nothing to release — and a throw would turn an unconditional
// cleanup call into a crash.
export const CHROME_ADAPTER = {
  runsLocally: true,
  preflight: notImplemented,
  send: notImplemented,
  close: () => {},
}
