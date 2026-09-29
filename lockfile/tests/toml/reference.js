// Python's tomllib as the reference: a TOML 1.0 reader in the standard
// library since 3.11. Each document is read in one python3 process, and
// comes back as { value } with offset date-times as UTC instants to the
// microsecond, or { error }. Undefined where there is no such python.
//
// Keys are written with nothing in them for JSON to escape: anything but
// printable ASCII, and `"`, `\` and `%`, as `%<hex>;`. V8's JSON.parse (13.6,
// in Node 24.15) can read one escaped key as another that an earlier parse
// met in the same place: after `{"a":1,"\\":2}`, `{"a":1,"\n":2}` comes
// back with a backslash for its key.
import { spawnSync } from 'node:child_process'
import { TomlDateTime } from '../../toml.js'

const SCRIPT = `
import datetime, json, sys, tomllib
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
    if isinstance(value, (str, bool, int)):
        return value
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

// A parsed document as tomllib's JSON has it.
export function plain(value) {
  if (value instanceof TomlDateTime) return { $datetime: instant(value) }
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [keyOf(key), plain(item)]))
  return value
}
