// Through globalThis because the export shadows the global: `(url, options) => fetch(url, options)`
// names itself. Read per call, so a page that installs its own fetch is used.
export const fetch = (url, options) => globalThis.fetch(url, options)
