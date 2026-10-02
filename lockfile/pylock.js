// pylock.toml, `lock-version = "1.0"`, PEP 751's lockfile, as uv and pip
// write it: every field checked as packaging's Pylock checks it and more,
// each file's name held to its package, and each entry's dependencies
// resolved to the entries they name. pylock.d.ts says what comes back.
// Reading only; nothing here writes a lockfile.
export { parsePylock } from './src/pylock/parse.js'
export { LockfileError } from './src/error.js'
// What the TOML beneath is refused with, from the parser in toml.js.
export { TomlError } from './src/toml/error.js'
