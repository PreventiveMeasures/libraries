// What reading a podspec in the form podspec-read.js reads is done with: the token at hand, and what is refused.

import { PodError } from './error.js'
import { plain } from './podspec-json.js'

export const peek = (p) => p.tokens[p.at]
export const next = (p) => p.tokens[p.at++]
export const is = (p, type, value) => peek(p).type === type && (value === undefined || peek(p).value === value)
export function fail(p, what, token = peek(p)) {
  throw new PodError(`line ${token.line}: ${what}, which is not in the form of a podspec that is read without Ruby`, p.where)
}
export function expect(p, type, value) {
  if (!is(p, type, value)) fail(p, `\`${peek(p).value ?? peek(p).type}\` where \`${value ?? type}\` is expected`)
  return next(p)
}
export const skipLines = (p) => {
  while (is(p, 'newline') || is(p, ';')) next(p)
}
// What holds, to Ruby: all but nil and false.
export const truthy = (value) => value !== null && value !== false

// A value as Ruby's to_s has it in a string.
export function text(p, value) {
  if (typeof value === 'string') return plain(value)
  if (typeof value === 'number') return String(value)
  if (value === null) return ''
  return typeof value === 'boolean' ? String(value) : fail(p, 'a list, a hash or a specification in a string')
}

// Something of the podspec is changed, a list, a hash or a specification: which the side of a condition that
// is not taken may not do, both sides being read. `untaken` refuses one that did.
export const changed = (p) => void p.state.changes++
export const untaken = (p, did, token) => did && fail(p, 'a change in the side of a condition that is not taken', token)
