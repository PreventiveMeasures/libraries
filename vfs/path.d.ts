// Hand-written against path.js; a change to either belongs with the other.
//
// POSIX paths as node:path.posix reads them, with the same names and the
// same answers, and no working directory: `resolve` starts from `/`. The one
// difference is `basename` with a suffix, which answers the name less the
// suffix where node slips on a path of only slashes or a trailing slash.
// All of it is lexical: nothing here consults a filesystem, and a Vfs walks
// the spelling it is given rather than a folded one.

export const sep: '/'
export function isAbsolute(path: string): boolean
// The non-empty components of a spelling, `.` and `..` kept.
export function segments(path: string): string[]
export function normalize(path: string): string
export function join(...paths: string[]): string
export function resolve(...paths: string[]): string
export function relative(from: string, to: string): string
export function dirname(path: string): string
export function basename(path: string, suffix?: string): string
export function extname(path: string): string
// Code point order, which is UTF-8 byte order; a sort key for names.
export function compareNames(a: string, b: string): number
