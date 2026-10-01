// yarn's own lockfile reader as the reference: the tokenizer and parser of
// yarn 1.22.22 (src/lockfile/parse.js, as lib/cli.js ships it), written
// back from its Babel output with nothing changed but the syntax. It comes
// back as { value } where yarn reads the text itself, and { error } where
// it does not: where yarn would merge the sides of a conflict, or, on a
// syntax error, read the text again as YAML, which is not done here.
//
// Copyright (c) 2016-present, Yarn Contributors. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//  * Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
//  * Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
// IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
// THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
// PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
// CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
// EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
// PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
// LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
// NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

const LOCKFILE_VERSION = 1
const VERSION_REGEX = /^yarn lockfile v(\d+)$/u

const TOKEN_TYPES = {
  boolean: 'BOOLEAN',
  string: 'STRING',
  eof: 'EOF',
  colon: 'COLON',
  newline: 'NEWLINE',
  comment: 'COMMENT',
  indent: 'INDENT',
  invalid: 'INVALID',
  number: 'NUMBER',
  comma: 'COMMA',
}

const VALID_PROP_VALUE_TOKENS = new Set([TOKEN_TYPES.boolean, TOKEN_TYPES.string, TOKEN_TYPES.number])

// Where a quoted string ends: past the first quote without a backslash
// before it, or with two.
function stringEnd(input) {
  let i = 1
  for (; i < input.length; i++) {
    if (input[i] === '"' && !(input[i - 1] === '\\' && input[i - 2] !== '\\')) return i + 1
  }
  return i
}

function* tokenise(input) {
  let lastNewline = false
  let line = 1
  let col = 0

  const buildToken = (type, value) => ({ line, col, type, value })

  while (input.length) {
    let chop = 0

    if (input[0] === '\n' || input[0] === '\r') {
      chop++
      if (input[1] === '\n') chop++
      line++
      col = 0
      yield buildToken(TOKEN_TYPES.newline)
    } else if (input[0] === '#') {
      chop++
      let nextNewline = input.indexOf('\n', chop)
      if (nextNewline === -1) nextNewline = input.length
      const val = input.slice(chop, nextNewline)
      chop = nextNewline
      yield buildToken(TOKEN_TYPES.comment, val)
    } else if (input[0] === ' ') {
      if (lastNewline) {
        let indentSize = 1
        for (let i = 1; input[i] === ' '; i++) indentSize++
        if (indentSize % 2) throw new TypeError('Invalid number of spaces')
        chop = indentSize
        yield buildToken(TOKEN_TYPES.indent, indentSize / 2)
      } else {
        chop++
      }
    } else if (input[0] === '"') {
      const i = stringEnd(input)
      const val = input.slice(0, i)
      chop = i
      try {
        yield buildToken(TOKEN_TYPES.string, JSON.parse(val))
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        yield buildToken(TOKEN_TYPES.invalid)
      }
    } else if (/^\d/u.test(input)) {
      const val = /^\d+/u.exec(input)[0]
      chop = val.length
      yield buildToken(TOKEN_TYPES.number, +val)
    } else if (input.startsWith('true')) {
      yield buildToken(TOKEN_TYPES.boolean, true)
      chop = 4
    } else if (input.startsWith('false')) {
      yield buildToken(TOKEN_TYPES.boolean, false)
      chop = 5
    } else if (input[0] === ':') {
      yield buildToken(TOKEN_TYPES.colon)
      chop++
    } else if (input[0] === ',') {
      yield buildToken(TOKEN_TYPES.comma)
      chop++
    } else if (/^[a-zA-Z/.-]/u.test(input)) {
      let i = 0
      for (; i < input.length; i++) {
        const char = input[i]
        if (char === ':' || char === ' ' || char === '\n' || char === '\r' || char === ',') break
      }
      const name = input.slice(0, i)
      chop = i
      yield buildToken(TOKEN_TYPES.string, name)
    } else {
      yield buildToken(TOKEN_TYPES.invalid)
    }

    if (!chop) yield buildToken(TOKEN_TYPES.invalid)

    col += chop
    lastNewline = input[0] === '\n' || (input[0] === '\r' && input[1] === '\n')
    input = input.slice(chop)
  }

  yield buildToken(TOKEN_TYPES.eof)
}

class Parser {
  constructor(input) {
    this.tokens = tokenise(input)
  }

  onComment(token) {
    const versionMatch = token.value.trim().match(VERSION_REGEX)
    if (versionMatch && +versionMatch[1] > LOCKFILE_VERSION) throw new Error(`Can't install from a lockfile of version ${versionMatch[1]}`)
  }

  next() {
    const { done, value } = this.tokens.next()
    if (done || !value) throw new Error('No more tokens')
    if (value.type === TOKEN_TYPES.comment) {
      this.onComment(value)
      return this.next()
    }
    return (this.token = value)
  }

  unexpected(msg = 'Unexpected token') {
    throw new SyntaxError(`${msg} ${this.token.line}:${this.token.col}`)
  }

  parse(indent = 0) {
    const obj = Object.create(null)

    while (true) {
      const propToken = this.token

      if (propToken.type === TOKEN_TYPES.newline) {
        const nextToken = this.next()
        if (!indent) continue
        if (nextToken.type !== TOKEN_TYPES.indent) break
        if (nextToken.value === indent) this.next()
        else break
      } else if (propToken.type === TOKEN_TYPES.indent) {
        if (propToken.value === indent) this.next()
        else break
      } else if (propToken.type === TOKEN_TYPES.eof) {
        break
      } else if (propToken.type === TOKEN_TYPES.string) {
        const key = propToken.value
        if (!key) throw new Error('Expected a key')
        const keys = [key]
        this.next()

        while (this.token.type === TOKEN_TYPES.comma) {
          this.next()
          const keyToken = this.token
          if (keyToken.type !== TOKEN_TYPES.string) this.unexpected('Expected string')
          if (!keyToken.value) throw new Error('Expected a key')
          keys.push(keyToken.value)
          this.next()
        }

        const wasColon = this.token.type === TOKEN_TYPES.colon
        if (wasColon) this.next()

        if (VALID_PROP_VALUE_TOKENS.has(this.token.type)) {
          for (const k of keys) obj[k] = this.token.value
          this.next()
        } else if (wasColon) {
          const val = this.parse(indent + 1)
          for (const k of keys) obj[k] = val
          if (indent && this.token.type !== TOKEN_TYPES.indent) break
        } else {
          this.unexpected('Invalid value type')
        }
      } else {
        this.unexpected(`Unknown token: ${propToken.type}`)
      }
    }

    return obj
  }
}

const hasMergeConflicts = (str) => str.includes('<<<<<<<') && str.includes('=======') && str.includes('>>>>>>>')

export function yarnParse(text) {
  const str = text.codePointAt(0) === 0xFEFF ? text.slice(1) : text
  if (hasMergeConflicts(str)) return { error: 'a merge conflict' }
  try {
    const parser = new Parser(str)
    parser.next()
    return { value: parser.parse() }
  } catch (error) {
    return { error: error.message }
  }
}
