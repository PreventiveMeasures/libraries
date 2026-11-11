// Property lists, read: the ASCII form of a project.pbxproj and the XML form of an Info.plist. Dictionaries are
// objects without a prototype, and the rest strings, but for arrays and XML's true and false.

import { PodError } from '../error.js'

const BARE = /[\w$./:-]/u
const ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', '"': '"', "'": "'", '\\': '\\', '\n': '\n' }

// `{ key = value; }`, `( value, )`, a bare or a quoted string, and comments.
export function parseAscii(text, where) {
  let at = 0
  const fail = (what) => { throw new PodError(`${what} at ${at} of the project file`, where) }
  const skip = () => {
    for (;;) {
      while (at < text.length && /\s/u.test(text[at])) at++
      if (text.startsWith('/*', at)) at = text.indexOf('*/', at) + 2
      else if (text.startsWith('//', at)) at = text.indexOf('\n', at) + 1
      else return
      if (at < 2) fail('a comment that does not end')
    }
  }
  const quoted = () => {
    let out = ''
    for (at++; text[at] !== '"'; at++) {
      if (at >= text.length) fail('a string that does not end')
      if (text[at] !== '\\') out += text[at]
      else if (text[at + 1] === 'U') {
        out += String.fromCodePoint(Number.parseInt(text.slice(at + 2, at + 6), 16))
        at += 5
      } else if (/[0-7]/u.test(text[at + 1])) {
        const digits = /^[0-7]{1,3}/u.exec(text.slice(at + 1))[0]
        out += String.fromCodePoint(Number.parseInt(digits, 8))
        at += digits.length
      } else out += ESCAPES[text[++at]] ?? fail('an escape that is not one')
    }
    at++
    return out
  }
  const value = () => {
    skip()
    if (text[at] === '{') return dictionary()
    if (text[at] === '(') return list()
    if (text[at] === '"') return quoted()
    const start = at
    while (at < text.length && BARE.test(text[at])) at++
    return at === start ? fail('a value that is none') : text.slice(start, at)
  }
  const expect = (char) => {
    skip()
    if (text[at++] !== char) fail(`no \`${char}\``)
  }
  const dictionary = () => {
    const out = { __proto__: null }
    for (at++, skip(); text[at] !== '}'; skip()) {
      const key = value()
      expect('=')
      out[key] = value()
      expect(';')
    }
    at++
    return out
  }
  const list = () => {
    const out = []
    for (at++, skip(); text[at] !== ')'; skip()) {
      out.push(value())
      skip()
      if (text[at] === ',') at++
    }
    at++
    return out
  }
  const root = value()
  skip()
  if (at < text.length) fail('more than one value')
  return root
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const unescapeXml = (text) => text.replaceAll(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/giu, (all, decimal, hex, name) => (decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ENTITIES[name] ?? all))

// Of the elements an Info.plist is made of.
export function parseXml(text, where) {
  const tokens = text.replaceAll(/<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--.*?-->/gsu, '').matchAll(/<(\/?)([\w-]+)[^>]*?(\/?)>|([^<]+)/gu)
  const stack = [{ tag: 'root', items: [] }]
  for (const [, closing, tag, selfClosing, chars] of tokens) {
    const top = stack.at(-1)
    if (chars !== undefined) top.text = (top.text ?? '') + chars
    else if (closing === '' && selfClosing === '') stack.push({ tag, items: [] })
    else {
      const node = closing === '' ? { tag, items: [] } : stack.pop()
      if (node.tag !== tag || stack.length === 0) throw new PodError('a property list that is not well formed', where)
      stack.at(-1).items.push(valueOf(node, where))
    }
  }
  const plist = stack[0].items[0]
  if (stack.length !== 1 || plist === undefined) throw new PodError('a property list that is not well formed', where)
  return plist
}
function valueOf({ tag, items, text = '' }, where) {
  switch (tag) {
    case 'plist': return items[0]
    case 'dict': {
      const out = { __proto__: null }
      for (let i = 0; i + 1 < items.length; i += 2) out[items[i].key] = items[i + 1]
      return out
    }
    case 'key': return { key: unescapeXml(text) }
    case 'array': return items
    case 'string': return unescapeXml(text)
    case 'integer': case 'real': case 'date': case 'data': return text.trim()
    case 'true': return true
    case 'false': return false
    default: throw new PodError(`a property list with a <${tag}>`, where)
  }
}
