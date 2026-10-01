// soldeer.lock, as Soldeer 0.4 to 0.12 write it: every entry checked, and
// with the config the dependencies it holds them to. soldeer.d.ts says what
// comes back. Reading only; nothing here writes a lockfile.
export { parseSoldeerLockfile } from './src/soldeer/parse.js'
export { LockfileError } from './src/error.js'
// What the TOML beneath is refused with, from the parser in toml.js.
export { TomlError } from './src/toml/error.js'
