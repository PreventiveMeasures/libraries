// Python's packaging as the reference: what it makes of a version, a
// specifier set, a marker, a requirement, a name and a wheel's or an
// sdist's file name, all in one process. PYTHON names the interpreter,
// python3 by default; undefined comes back where it, or packaging, is
// missing. With packaging 25.1 or later, which has packaging.pylock, a
// pylock.toml is checked too, read with tomllib.
import { spawnSync } from 'node:child_process'

const SCRIPT = `
import json, sys, tomllib
from packaging.version import Version
from packaging.specifiers import SpecifierSet
from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, is_normalized_name, parse_sdist_filename, parse_wheel_filename
try:
    from packaging.pylock import Pylock
except ImportError:
    Pylock = None
def version(text):
    return str(Version(text))
def same(pair):
    return Version(pair[0]) == Version(pair[1])
def specifiers(text):
    SpecifierSet(text)
    return True
def marker(text):
    Marker(text)
    return True
def requirement(text):
    Requirement(text)
    return True
def name(text):
    return [canonicalize_name(text), is_normalized_name(text)]
def wheel(text):
    parsed = parse_wheel_filename(text)
    return [parsed[0], str(parsed[1])]
def sdist(text):
    parsed = parse_sdist_filename(text)
    return [parsed[0], str(parsed[1])]
def pylock(text):
    if Pylock is None:
        return 'unavailable'
    Pylock.from_dict(tomllib.loads(text))
    return True
KINDS = {'version': version, 'same': same, 'specifiers': specifiers, 'marker': marker, 'requirement': requirement, 'name': name, 'wheel': wheel, 'sdist': sdist, 'pylock': pylock}
results = []
for kind, text in json.load(sys.stdin):
    try:
        results.append({'value': KINDS[kind](text)})
    except Exception as error:
        results.append({'error': type(error).__name__})
json.dump(results, sys.stdout)
`

// Each case is [kind, input]; each result { value } or { error }.
export function packaging(cases) {
  const run = spawnSync(process.env.PYTHON ?? 'python3', ['-c', SCRIPT], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.error !== undefined || run.status !== 0) return undefined
  return JSON.parse(run.stdout)
}

export const hasPackaging = () => packaging([['version', '1.0']])?.[0]?.value === '1.0'

export const hasPylock = () => {
  const result = packaging([['pylock', 'lock-version = "1.0"\ncreated-by = "x"\npackages = []\n']])?.[0]
  return result !== undefined && result.value === true
}
