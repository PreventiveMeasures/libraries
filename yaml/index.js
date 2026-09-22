// The package's public surface: everything outside `yaml/` goes through this
// file, and nothing outside it reaches for a module by name. What is listed
// here is what a caller actually needs — a name absent from it is internal,
// free to move between the modules below without a single edit elsewhere.
//
// Inside, `yaml/` stands alone — no imports at all beyond its own modules
// (self-contained.test.js enforces it), and nothing that assumes a
// filesystem, a terminal or a locale of its own.

// A document read into the data it carries: the subset of YAML that pnpm
// lockfiles are written in, and a YamlError at anything else. The result is
// a mapping (a null-prototype object) or a sequence of plain data.
export { parseYaml } from './src/parse.js'

// What is thrown at a document that cannot be read, malformed or refused
// alike; `line` says where.
export { YamlError } from './src/error.js'
