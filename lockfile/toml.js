// A minimal, strict TOML parser: the TOML that Cargo.toml, Cargo.lock,
// uv.lock, poetry.lock, pylock.toml and foundry.toml are written in, comments
// dropped, anything else refused by name. toml.d.ts says what it takes.
export { parseToml } from './src/toml/parse.js'
export { isInlineTable } from './src/toml/value.js'
export { TomlDateTime } from './src/toml/datetime.js'
export { TomlFloat } from './src/toml/number.js'
export { TomlError } from './src/toml/error.js'
