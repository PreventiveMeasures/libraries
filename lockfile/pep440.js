// PEP 440 versions as packaging reads, writes and orders them, on their own:
// what the Python lockfiles are read by. pep440.d.ts says what they take.
export { compareVersions, normalVersion, parseVersion, versionKey } from './src/python/pep440.js'
