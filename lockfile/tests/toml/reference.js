// Python's tomllib as the reference: a TOML 1.0 reader in the standard
// library since 3.11. Each document is read in one python3 process, and
// comes back as { value }, or { error }, undefined where there is no such
// python. In the value, an offset date-time is its UTC instant to the
// microsecond, a float the 64 bits of its double (a NaN is only NaN, as
// TOML gives it no sign), and an integer past 2^53 its decimal digits,
// which a JSON number would round.
//
// Keys are written with nothing in them for JSON to escape: anything but
// printable ASCII, and `"`, `\` and `%`, as `%<hex>;`. V8's JSON.parse (13.6,
// in Node 24.15) can read one escaped key as another that an earlier parse
// met in the same place: after `{"a":1,"\\":2}`, `{"a":1,"\n":2}` comes
// back with a backslash for its key.
import { spawnSync } from 'node:child_process'
import { TomlDateTime, TomlFloat } from '../../toml.js'

const SCRIPT = `
import datetime, json, struct, sys, tomllib
def key(text):
    return ''.join(c if ' ' <= c <= '~' and c not in '"\\\\%' else f'%{ord(c):x};' for c in text)
def encode(value):
    if isinstance(value, dict):
        return {key(name): encode(item) for name, item in value.items()}
    if isinstance(value, list):
        return [encode(item) for item in value]
    if isinstance(value, datetime.datetime) and value.tzinfo is not None:
        # The calendar repeats every 400 years: shifted by that, a date near
        # year 1 or 9999 stays in datetime's range when taken to UTC.
        shift = 400 if value.year < 5000 else -400
        utc = value.replace(year=value.year + shift).astimezone(datetime.timezone.utc)
        return {'$datetime': f'{utc.year - shift:04d}' + utc.strftime('-%m-%dT%H:%M:%S.%fZ')}
    if isinstance(value, float):
        return {'$float': 'nan' if value != value else struct.pack('>d', value).hex()}
    if isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 2 ** 53 - 1 else {'$int': str(value)}
    return {'$other': repr(value)}
results = []
for text in json.load(sys.stdin):
    try:
        results.append({'value': encode(tomllib.loads(text))})
    except tomllib.TOMLDecodeError as error:
        results.append({'error': str(error)})
json.dump(results, sys.stdout)
`

export function tomllib(texts) {
  const run = spawnSync('python3', ['-c', SCRIPT], { input: JSON.stringify(texts), encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.error !== undefined || run.status !== 0) return undefined
  return JSON.parse(run.stdout)
}

export const hasTomllib = () => tomllib(['a = 1'])?.[0]?.value?.a === 1

// What tomllib's JSON has for a date-time: the UTC instant, microseconds and
// all, the year in four digits or more (0000 and 10000 among them).
function instant(datetime) {
  const date = datetime.toDate()
  const fraction = /\.(\d+)/u.exec(datetime.text)?.[1] ?? ''
  return `${String(date.getUTCFullYear()).padStart(4, '0')}${date.toISOString().slice(-20, -1)}${fraction.padEnd(6, '0').slice(3, 6)}Z`
}

const keyOf = (key) => key.replace(/[^ -~]|["%\\]/gu, (char) => `%${char.codePointAt(0).toString(16)};`)

function bits(number) {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, number)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

// A parsed document as tomllib's JSON has it.
export function plain(value) {
  if (value instanceof TomlDateTime) return { $datetime: instant(value) }
  if (value instanceof TomlFloat) return { $float: Number.isNaN(value.value) ? 'nan' : bits(value.value) }
  if (typeof value === 'bigint') return { $int: String(value) }
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [keyOf(key), plain(item)]))
  return value
}
