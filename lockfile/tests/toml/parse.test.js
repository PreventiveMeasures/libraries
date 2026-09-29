import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TomlDateTime, TomlError, TomlFloat, parseToml } from '../../toml.js'

// Tables come back with a null prototype, which strict deepEqual holds
// against a literal; structuredClone gives them Object.prototype back and
// changes nothing else, so every comparison goes through it.
const parse = (text) => structuredClone(parseToml(text))

// A refusal is a TomlError with a message that says why, and the line it
// happened on: `line` counts from zero here, as the property does.
const refuses = (text, message, line) => assert.throws(() => parseToml(text), (error) => {
  assert.ok(error instanceof TomlError, error.stack)
  assert.equal(error.message, `${message} at line ${line + 1}`)
  assert.equal(error.line, line)
  return true
})

describe('what is read', () => {
  it('nothing, comments and blank lines', () => {
    assert.deepEqual(parse(''), {})
    assert.deepEqual(parse('# a comment\n\n   \t\n# another\n'), {})
    assert.equal(Object.getPrototypeOf(parseToml('')), null)
  })

  it('keys: bare, quoted, literal, empty, dotted', () => {
    assert.deepEqual(parse('a = 1\nb-c_d = 2\n1234 = 3\n"q k" = 4\n\'l k\' = 5\n"" = 6\n'), { a: 1, 'b-c_d': 2, 1234: 3, 'q k': 4, 'l k': 5, '': 6 })
    assert.deepEqual(parse('a.b.c = 1\na . d = 2\n"x.y".z = 3\n'), { a: { b: { c: 1 }, d: 2 }, 'x.y': { z: 3 } })
  })

  it('names a prototype has are names like any other', () => {
    const doc = parseToml('__proto__ = 1\nconstructor.x = 2\n')
    assert.equal(doc.__proto__, 1)
    assert.equal(Object.getPrototypeOf(doc), null)
    assert.equal(Object.getPrototypeOf(doc.constructor), null)
  })

  it('basic strings, with every TOML 1.0 escape', () => {
    assert.deepEqual(parse('a = "x\\b\\t\\n\\f\\r\\"\\\\y"\nb = "\\u00e9\\U0001F600"\nc = ""\nd = "tab\there # not a comment"\n'), {
      a: 'x\b\t\n\f\r"\\y', b: 'é😀', c: '', d: 'tab\there # not a comment',
    })
  })

  it('controls of C1 and tabs, which TOML leaves to strings and comments', () => {
    assert.deepEqual(parse('a = "x\u0085\u009Fy" # \u0080\tz\nb = \'\u0085\t\'\n'), { a: 'x\u0085\u009Fy', b: '\u0085\t' })
  })

  it('literal strings, as written', () => {
    assert.deepEqual(parse("a = 'C:\\path\\n'\nb = ''\nc = 'say \"hi\"'\n"), { a: 'C:\\path\\n', b: '', c: 'say "hi"' })
  })

  it('multi-line basic strings: the first line break dropped, CRLF as LF, escapes, and a backslash that ends a line', () => {
    assert.deepEqual(parse('a = """\nRoses are red\r\nViolets are blue"""\nb = """one\\ttwo \\u00e9\\\n\n   \t  three \\  \r\n  four"""\nc = """"""\n'), {
      a: 'Roses are red\nViolets are blue', b: 'one\ttwo éthree four', c: '',
    })
  })

  it('multi-line strings end at the first three quotes, which one or two more may follow', () => {
    assert.deepEqual(parse('a = """x""y"""\nb = """x""""\nc = """x"""""\nd = """\\""""""\ne = \'\'\'x\'\'y\'\'\'\'\'\n'), {
      a: 'x""y', b: 'x"', c: 'x""', d: '"""', e: "x''y''",
    })
    refuses('a = """x""""""\n', 'expected the end of the line, found "\\""', 0)
  })

  it('multi-line literal strings, as written, a backslash and all', () => {
    assert.deepEqual(parse("a = '''\nC:\\dir\\\n  'quoted' \"too\"\r\n'''\nb = ''''''\n"), { a: 'C:\\dir\\\n  \'quoted\' "too"\n', b: '' })
  })

  it('multi-line strings as values anywhere, and lines counted through them', () => {
    assert.deepEqual(parse('a = ["""\n1""", \'\'\'2\n\'\'\']\nb = { c = """\nx\ny""" }\n'), { a: ['1', '2\n'], b: { c: 'x\ny' } })
    refuses('a = """\n\nx"""\nb = 1 c\n', 'expected the end of the line, found "c"', 3)
  })

  it('integers, underscores between digits, and no negative zero', () => {
    const doc = parseToml('a = 1\nb = +42\nc = -17\nd = 1_000_000\ne = -0\nf = 9007199254740991\ng = -9_007_199_254_740_991\n')
    assert.deepEqual(structuredClone(doc), { a: 1, b: 42, c: -17, d: 1000000, e: 0, f: 2 ** 53 - 1, g: -(2 ** 53 - 1) })
    assert.ok(Object.is(doc.e, 0))
  })

  it('integers in hexadecimal, octal and binary, leading zeros allowed', () => {
    assert.deepEqual(parse('a = 0xDEAD_beef\nb = 0o7_55\nc = 0b1_0\nd = 0x0000000000000000000001\ne = 0x0\n'), { a: 0xDEADBEEF, b: 0o755, c: 2, d: 1, e: 0 })
  })

  it('integers past 2^53 as bigints, never rounded, to the ends of 64 bits', () => {
    const doc = parseToml('a = 9007199254740992\nb = 9223372036854775807\nc = -9_223_372_036_854_775_808\nd = 0x7FFF_FFFF_FFFF_FFFF\ne = -9007199254740991\n')
    assert.deepEqual({ ...doc }, { a: 2n ** 53n, b: 2n ** 63n - 1n, c: -(2n ** 63n), d: 2n ** 63n - 1n, e: -(2 ** 53 - 1) })
  })

  it('floats, each a TomlFloat, as written and as the double it names', () => {
    const doc = parseToml('a = 1.0\nb = -3.1_415e+2\nc = 5e-324\nd = -0.0\ne = inf\nf = -inf\ng = nan\nh = 1E3\n')
    for (const value of Object.values(doc)) assert.ok(value instanceof TomlFloat)
    assert.deepEqual(Object.values(doc).map((value) => value.text), ['1.0', '-3.1_415e+2', '5e-324', '-0.0', 'inf', '-inf', 'nan', '1E3'])
    assert.deepEqual(Object.values(doc).map((value) => value.value), [1, -314.15, 5e-324, -0, Infinity, -Infinity, Number.NaN, 1000])
    assert.ok(Object.is(doc.d.value, -0))
    assert.equal(doc.a + 1, 2)
    assert.equal(`${doc.b}`, '-3.1_415e+2')
    assert.equal(JSON.stringify(doc.a), '1')
  })

  it('floats are frozen, and made only from what they read', () => {
    assert.ok(Object.isFrozen(new TomlFloat('1.5')))
    for (const text of ['1', '1.', '.5', '1e400', '0x1p3', 1.5]) assert.throws(() => new TomlFloat(text), TypeError)
  })

  it('booleans', () => {
    assert.deepEqual(parse('a = true\nb = false\n'), { a: true, b: false })
  })

  it('arrays: across lines, with comments and a trailing comma, nested and mixed', () => {
    const doc = 'a = []\nb = [ 1, 2 ]\nc = [\n  "x", # first\n  # between\n  \'y\',\n]\nd = [[1], [2, [3]], "s", { k = 1 }]\ne = [\n]\n'
    assert.deepEqual(parse(doc), { a: [], b: [1, 2], c: ['x', 'y'], d: [[1], [2, [3]], 's', { k: 1 }], e: [] })
  })

  it('inline tables: empty, nested, and dotted within', () => {
    assert.deepEqual(parse('a = {}\nb = { x = 1, y = { z = "s" } }\nc = { p.q = 1, p.r = 2, "s.t" = 3 }\nd = {k=1}\n'), {
      a: {}, b: { x: 1, y: { z: 's' } }, c: { p: { q: 1, r: 2 }, 's.t': 3 }, d: { k: 1 },
    })
    // One line, but for an array within, which may run on as arrays do.
    assert.deepEqual(parse('a = { b = [\n  1,\n  # c\n  2 ] }\n'), { a: { b: [1, 2] } })
    refuses('a = { b = [\n1 ]\n}\n', 'an inline table across lines is not supported', 1)
  })

  it('tables, and a table declared after one beneath it', () => {
    assert.deepEqual(parse('x = 0\n[a]\nb = 1\n[ c . d ]\ne = 2\n[c]\nf = 3\n["q k".\'l\']\ng = 4\n'), {
      x: 0, a: { b: 1 }, c: { d: { e: 2 }, f: 3 }, 'q k': { l: { g: 4 } },
    })
  })

  it('arrays of tables, and headers through their last table', () => {
    const doc = '[[p]]\nn = 1\n[p.meta]\nm = "a"\n[[p.w]]\nu = 1\n[p.w.h]\ns = 2\n[[p]]\nn = 2\n[[p.w]]\nu = 3\n'
    assert.deepEqual(parse(doc), { p: [{ n: 1, meta: { m: 'a' }, w: [{ u: 1, h: { s: 2 } }] }, { n: 2, w: [{ u: 3 }] }] })
  })

  it('a table beneath one dotted keys made, from a header', () => {
    assert.deepEqual(parse('[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true\n'), {
      fruit: { apple: { color: 'red', taste: { sweet: true }, texture: { smooth: true } } },
    })
  })

  it('no dotted key through a table only a header on the way has made, which TOML readers differ on', () => {
    refuses('[a.b.c]\n[a]\nb.d = 1\n', 'a dotted key through "b", a table a header made on its way, is not supported', 2)
    refuses('[a.b.d]\n[a]\nb.c.d = 1\n', 'a dotted key through "b", a table a header made on its way, is not supported', 2)
    assert.deepEqual(parse('[a.b.c]\n[a.b]\nx = 1\n'), { a: { b: { c: {}, x: 1 } } })
  })

  it('CRLF line ends, trailing comments and whitespace, and no final line break', () => {
    assert.deepEqual(parse('a = 1 # one\r\n[t]\t# a table\r\nb = [\r\n  2,\r\n]\r\n\tc = "3"'), { a: 1, t: { b: [2], c: '3' } })
  })
})

describe('offset date-times', () => {
  it('as written, and the instant they name', () => {
    const doc = parseToml('a = 2026-09-05T10:42:39Z\nb = 1979-05-27T00:32:00.999999-07:00\nc = [2024-02-29T23:59:59+05:30]\n')
    assert.ok(doc.a instanceof TomlDateTime)
    assert.equal(doc.a.text, '2026-09-05T10:42:39Z')
    assert.equal(doc.a.toDate().toISOString(), '2026-09-05T10:42:39.000Z')
    assert.equal(doc.b.toDate().toISOString(), '1979-05-27T07:32:00.999Z')
    assert.equal(doc.c[0].toDate().toISOString(), '2024-02-29T18:29:59.000Z')
    assert.equal(String(doc.b), '1979-05-27T00:32:00.999999-07:00')
    assert.equal(JSON.stringify(doc.a), '"2026-09-05T10:42:39Z"')
  })

  it('years before 100 are not taken for the twentieth century', () => {
    assert.equal(parseToml('a = 0099-12-31T23:59:59Z\n').a.toDate().toISOString(), '0099-12-31T23:59:59.000Z')
  })

  it('are frozen, and made only from what they read', () => {
    const datetime = new TomlDateTime('2026-09-05T10:42:39Z')
    assert.ok(Object.isFrozen(datetime))
    for (const text of ['2026-02-30T00:00:00Z', '2026-09-05', '2026-09-05 10:42:39Z', 1]) {
      assert.throws(() => new TomlDateTime(text), TypeError)
    }
  })
})

describe('what is not supported is refused by name', () => {
  for (const [value, message] of [
    ['9223372036854775808', 'integer out of range "9223372036854775808"'],
    ['-9223372036854775809', 'integer out of range "-9223372036854775809"'],
    ['0x8000000000000000', 'integer out of range "0x8000000000000000"'],
    [`0b1${'0'.repeat(63)}`, `integer out of range "0b1${'0'.repeat(61)}"...`],
    [`1${'0'.repeat(100)}`, `integer out of range "1${'0'.repeat(63)}"...`],
    ['1e309', 'float out of range "1e309"'],
    ['-1.8e308', 'float out of range "-1.8e308"'],
    ['1e-400', 'float out of range "1e-400"'],
    ['1979-05-27', 'local dates and times are not supported: "1979-05-27"'],
    ['07:32:00', 'local dates and times are not supported: "07:32:00"'],
    ['1979-05-27T07:32:00', 'local dates and times are not supported: "1979-05-27T07:32:00"'],
    ['1979-05-27 07:32:00Z', 'a date-time with a space in place of "T" is not supported'],
    ['1979-05-27t07:32:00z', 'a date-time with a lower-case "t" or "z" is not supported: "1979-05-27t07:32:00z"'],
    ['0000-02-29T00:00:00Z', 'the year 0000 is not supported: "0000-02-29T00:00:00Z"'],
    ['1979-05-27T23:59:60Z', 'a leap second is not supported: "1979-05-27T23:59:60Z"'],
    ['1979-05-27T07:32:60.5+01:00', 'a leap second is not supported: "1979-05-27T07:32:60.5+01:00"'],
    ['"\\e"', 'unsupported escape "\\\\e"'],
    ['"\\x41"', 'unsupported escape "\\\\x"'],
    ['07:32', 'a date-time or a time without seconds is not supported: "07:32"'],
    ['1979-05-27T07:32Z', 'a date-time or a time without seconds is not supported: "1979-05-27T07:32Z"'],
    ['{ a = 1, }', 'a trailing comma in an inline table is not supported'],
    ['{ a = 1\n}', 'an inline table across lines is not supported'],
    ['{\n  a = 1 }', 'an inline table across lines is not supported'],
    ['{ a = 1, # c\n  b = 2 }', 'an inline table across lines is not supported'],
  ]) {
    it(value.replaceAll('\n', '\\n'), () => refuses(`k = ${value}\n`, message, 0))
  }
})

describe('what is not TOML is refused', () => {
  it('malformed values', () => {
    for (const [value, message] of [
      ['01', 'expected a value, found "01"'],
      ['1__0', 'expected a value, found "1__0"'],
      ['_1', 'expected a value, found "_1"'],
      ['1_', 'expected a value, found "1_"'],
      ['True', 'expected a value, found "True"'],
      ['', 'expected a value, found the end of the line'],
      ['.5', 'expected a value, found ".5"'],
      ['1.', 'expected a value, found "1."'],
      ['1e', 'expected a value, found "1e"'],
      ['1._5', 'expected a value, found "1._5"'],
      ['1e_5', 'expected a value, found "1e_5"'],
      ['01.5', 'expected a value, found "01.5"'],
      ['1.5.3', 'expected a value, found "1.5.3"'],
      ['Inf', 'expected a value, found "Inf"'],
      ['NaN', 'expected a value, found "NaN"'],
      ['+0x1', 'expected a value, found "+0x1"'],
      ['-0o7', 'expected a value, found "-0o7"'],
      ['0X1F', 'expected a value, found "0X1F"'],
      ['0x', 'expected a value, found "0x"'],
      ['0x_1', 'expected a value, found "0x_1"'],
      ['0b12', 'expected a value, found "0b12"'],
      ['0o8', 'expected a value, found "0o8"'],
      ['"""a\u0001b"""', 'U+0001 is not allowed in a string'],
      ["'''a\u007Fb'''", 'U+007F is not allowed in a string'],
      ['"""a\\ b"""', 'unsupported escape "\\\\ "'],
      ['"\\q"', 'unsupported escape "\\\\q"'],
      ['"\\uD800"', '\\uD800 is not a Unicode scalar value'],
      ['"\\U00110000"', '\\U00110000 is not a Unicode scalar value'],
      ['"open', 'unterminated string'],
      ["'open", 'unterminated string'],
      ['"a\u0001b"', 'U+0001 is not allowed in a string'],
      ["'a\u007Fb'", 'U+007F is not allowed in a string'],
      ['2023-02-29T00:00:00Z', '"2023-02-29T00:00:00Z" is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)'],
      ['2024-04-31T00:00:00Z', '"2024-04-31T00:00:00Z" is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)'],
      ['1979-05-27T07:60:00Z', '"1979-05-27T07:60:00Z" is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)'],
      ['1979-05-27T07:32:00+24:00', '"1979-05-27T07:32:00+24:00" is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)'],
      ['[1 2]', 'expected "," or "]", found "2]"'],
      ['[,]', 'expected a value, found ",]"'],
      ['[1,,2]', 'expected a value, found ",2]"'],
      ['{ a = 1 b = 2 }', 'expected "," or "}" on the inline table\'s line, found "b = 2 }"'],
      ['{ a = 1, a = 2 }', 'duplicate key "a"'],
      ['{ a = { b = 1 }, a.c = 2 }', '"a" is an inline table, which a dotted key cannot add to'],
      ['{ a = 1, a.b = 2 }', '"a" is a value, which a dotted key cannot add to'],
    ]) {
      refuses(`k = ${value}\n`, message, 0)
    }
  })

  it('a multi-line string runs on to where the text ends, and no further', () => {
    refuses('k = """\nx\n', 'unterminated string', 2)
    refuses("k = '''x''\n", 'unterminated string', 1)
    refuses('k = """x\ry"""\n', 'a carriage return must be followed by a line feed', 0)
  })

  it('an array runs on past its line, to where the text ends', () => {
    refuses('k = [1\n', 'expected "," or "]", found the end of the text', 1)
    refuses('k = [\n1,\n# c\n', 'expected a value, found the end of the text', 3)
  })

  it('malformed lines', () => {
    refuses('a = 1 b = 2\n', 'expected the end of the line, found "b = 2"', 0)
    refuses('a 1\n', 'expected "=" after the key, found "1"', 0)
    refuses('= 1\n', 'expected a key, found "= 1"', 0)
    refuses('bad key = 1\n', 'expected "=" after the key, found "key = 1"', 0)
    refuses('a.= 1\n', 'expected a key, found "= 1"', 0)
    refuses('x = 1\n[a\n', 'expected "]", found the end of the line', 1)
    refuses('[[a]\n', 'expected "]]", found "]"', 0)
    refuses('[ [a] ]\n', 'expected a key, found "[a] ]"', 0)
    refuses('[]\n', 'expected a key, found "]"', 0)
    refuses('[a] b = 1\n', 'expected the end of the line, found "b = 1"', 0)
    refuses('"""k""" = 1\n', 'a multi-line string cannot be a key', 0)
    refuses("a.'''k''' = 1\n", 'a multi-line string cannot be a key', 0)
  })

  it('what is not text: a lone carriage return, control characters, a byte order mark, a lone surrogate, U+FFFD', () => {
    refuses('a = 1\rb = 2\n', 'a carriage return must be followed by a line feed', 0)
    refuses('a = 1\n\r', 'a carriage return must be followed by a line feed', 1)
    refuses('a = 1 # x\u0000y\n', 'U+0000 is not allowed in a comment', 0)
    refuses('# x\ry\n', 'a carriage return must be followed by a line feed', 0)
    refuses('\uFEFFa = 1\n', 'a byte order mark is not read', 0)
    refuses('a = 1\nb = "\uD800"\n', 'a lone surrogate is not well-formed Unicode', 1)
    // What a file that is not UTF-8 comes to when read without `fatal`.
    const lenient = Buffer.from([0x61, 0x20, 0x3D, 0x20, 0x22, 0xFF, 0x22, 0x0A]).toString('utf8')
    refuses(`# first\n${lenient}`, 'U+FFFD is not supported: a decoder puts it where bytes are not UTF-8', 1)
    // The decoding toml.d.ts gives keeps a byte order mark for the reader to refuse.
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from('﻿a = 1\n'))
    refuses(decoded, 'a byte order mark is not read', 0)
    assert.throws(() => parseToml(Buffer.from('a = 1')), { name: 'TypeError', message: 'expected a string' })
  })

  it('messages quote the text with controls, separators and bidi controls escaped, and cut between characters', () => {
    refuses('a = 1 ‮evil\n', 'expected the end of the line, found "\\u202eevil"', 0)
    refuses('[\u009B31m]\n', 'expected a key, found "\\u009b31m]"', 0)
    refuses('a = 1  x\n', 'expected the end of the line, found "\\u2028x"', 0)
    refuses('k = \u007F\n', 'expected a value, found "\\u007f"', 0)
    refuses(`a = 1 ${'x'.repeat(63)}😀tail\n`, `expected the end of the line, found "${'x'.repeat(63)}"...`, 0)
  })

  it('nesting past 64, however it is written', () => {
    refuses(`a = ${'['.repeat(66)}${']'.repeat(66)}\n`, 'nested too deep', 0)
    refuses(`a = ${'{ b = '.repeat(66)}1${' }'.repeat(66)}\n`, 'nested too deep', 0)
    refuses(`${Array.from({ length: 65 }, (_, i) => `k${i}`).join('.')} = 1\n`, 'a key with too many parts', 0)
    assert.doesNotThrow(() => parseToml(`a = ${'['.repeat(64)}${']'.repeat(64)}\n`))
  })
})

describe('what another module does to the prototypes', () => {
  it('a name set on Object.prototype turns no header into a key, and changes nothing read', () => {
    const text = '[package]\nname = "demo"\n[[bin]]\npath = { a.b = 1 }\n'
    const expected = parse(text)
    for (const name of ['value', 'keys', 'array', 'b', 'path']) {
      // eslint-disable-next-line no-extend-native -- a polluted prototype is what this test is about
      Object.prototype[name] = 'polluted'
      try {
        assert.deepEqual(parse(text), expected, name)
      } finally {
        delete Object.prototype[name]
      }
    }
  })
})

describe('what it costs', () => {
  // A message is put together only for a refusal, and shows no more of a
  // line than a person reads: were either made for every value, a line of
  // many of them would cost its length again for each.
  it('a line of two hundred thousand values in two seconds', () => {
    const text = `a = [${Array.from({ length: 200_000 }, (_, i) => i).join(', ')}]\n`
    const start = performance.now()
    assert.equal(parseToml(text).a.length, 200_000)
    assert.ok(performance.now() - start < 2000, `${Math.round(performance.now() - start)} ms`)
  })
})

describe('a table is written once', () => {
  it('a key once', () => {
    refuses('a = 1\na = 2\n', 'duplicate key "a"', 1)
    refuses('a.b = 1\na.b = 2\n', 'duplicate key "b"', 1)
    refuses('[t]\nx = 1\nx = 2\n', 'duplicate key "x"', 2)
  })

  it('a table once, by header', () => {
    refuses('[a]\n[a]\n', '"a" is a table already', 1)
    refuses('[a.b]\n[a]\n[a]\n', '"a" is a table already', 2)
    refuses('[a]\nb = 1\n[a.b]\n', '"a.b" is a value already', 2)
    refuses('[a.b]\n[a]\nb = 1\n', 'duplicate key "b"', 2)
  })

  it('an array of tables is not a table, nor the other way about', () => {
    refuses('[[a]]\n[a]\n', '"a" is an array of tables already', 1)
    refuses('[a]\n[[a]]\n', '"a" is a table, not an array of tables', 1)
    refuses('[a.b]\n[[a]]\n', '"a" is a table, not an array of tables', 1)
    refuses('a = []\n[[a]]\n', '"a" is an array, not an array of tables', 1)
  })

  it('nothing adds to what a value wrote', () => {
    refuses('a = { x = 1 }\n[a.b]\n', '"a" is an inline table, which a header cannot add to', 1)
    refuses('a = { x = 1 }\n[a]\n', '"a" is an inline table already', 1)
    refuses('a = [{ x = 1 }]\n[a.b]\n', '"a" is an array, which a header cannot add to', 1)
    refuses('a = 1\n[a.b]\n', '"a" is a value, which a header cannot add to', 1)
    refuses('a = { x = 1 }\na.y = 2\n', '"a" is an inline table, which a dotted key cannot add to', 1)
    refuses('a = [1]\na.y = 2\n', '"a" is an array, which a dotted key cannot add to', 1)
  })

  it('dotted keys and headers do not reopen each other\'s tables', () => {
    refuses('[fruit]\napple.color = "red"\n[fruit.apple]\n', '"fruit.apple" is a table already', 2)
    refuses('a.b = 1\n[a]\n', '"a" is a table already', 1)
    refuses('[a.b]\n[a]\nb.c = 1\n', '"b" is a table declared elsewhere, which a dotted key cannot add to', 2)
    refuses('[a]\nb.c = 1\n[x]\n[a.b.d]\n[a]\n', '"a" is a table already', 4)
    refuses('[[a.b]]\n[a]\nb.c = 1\n', '"b" is an array of tables, which a dotted key cannot add to', 2)
  })
})
