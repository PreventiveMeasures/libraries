// The public registry, and the names it takes: shared by every lookup
// in src/npm/.
export const REGISTRY = 'https://registry.npmjs.org'

// Same shape npm itself validates names against. A name that fails it
// never reaches a request.
export const packageNameRegex = /^(@[\da-z-]+\/)?[\w-]+(\.[\w-]+)*$/u
