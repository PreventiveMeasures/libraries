// Python's tomllib as the reference: a TOML 1.0 reader in the standard
// library since 3.11. Each document is read in one python3 process, and
// comes back as { value } with offset date-times as UTC instants to the
// microsecond, or { error }. Undefined where there is no such python.
import { spawnSync } from 'node:child_process'
import { TomlDateTime } from '../../toml.js'

const SCRIPT = `
import datetime, json, sys, tomllib
def encode(value):
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    if isinstance(value, list):
        return [encode(item) for item in value]
    if isinstance(value, datetime.datetime) and value.tzinfo is not None:
        return {'$datetime': value.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')}
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

// What tomllib's JSON has for a date-time: the UTC instant, microseconds and all.
function instant(datetime) {
  const fraction = /\.(\d+)/u.exec(datetime.text)?.[1] ?? ''
  return `${datetime.toDate().toISOString().slice(0, 23)}${fraction.padEnd(6, '0').slice(3, 6)}Z`
}

// A parsed document as tomllib's JSON has it.
export function plain(value) {
  if (value instanceof TomlDateTime) return { $datetime: instant(value) }
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}
