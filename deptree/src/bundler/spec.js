// A .gem's spec as Gem::Specification.from_yaml loads it: the fields an
// install reads, of the types RubyGems takes, as verify_spec holds them.

import { DeptreeError, quote } from '../error.js'
import { parsePlatform } from './platform.js'
import { DEFAULT, isOperator, isVersion } from './version.js'
import { parsePsych } from './yaml.js'

const TAG = '!ruby/object:Gem::'
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/u

// Gem::Specification::VALID_NAME_PATTERN.
const isName = (name) => /^[\w.-]+$/u.test(name)

function refuse(detail, where) {
  throw new DeptreeError(detail, where)
}

const isNull = (node) => node === undefined || (node.kind === 'scalar' && node.type === 'null')
const isString = (node) => node?.kind === 'scalar' && node.type === 'string'

function string(node, field, where) {
  if (!isString(node)) refuse(`${field} is no string`, where)
  return node.value
}

function strings(node, field, where) {
  if (isNull(node)) return []
  if (node.kind !== 'seq') refuse(`${field} is no list`, where)
  return node.items.map((item, i) => string(item, `${field}[${i}]`, where))
}

function tagged(node, name, field, where) {
  if (node?.kind !== 'map' || node.tag !== `${TAG}${name}`) refuse(`${field} is no Gem::${name}`, where)
  return node.entries
}

function version(node, field, where) {
  const entries = tagged(node, 'Version', field, where)
  const text = entries.get('version')
  if (entries.size !== 1 || !isString(text) || !isVersion(text.value)) refuse(`${field} is no version as RubyGems writes one`, where)
  return text.value
}

// A Gem::Requirement's [op, version] pairs; none, Gem::Requirement.default.
function requirement(node, field, where) {
  if (isNull(node)) return DEFAULT
  const entries = tagged(node, 'Requirement', field, where)
  const list = entries.get('requirements')
  if (list?.kind !== 'seq' || [...entries.keys()].some((key) => key !== 'requirements' && key !== 'none')) refuse(`${field} is no requirement as RubyGems writes one`, where)
  const pairs = list.items.map((pair, i) => {
    const here = `${field}.requirements[${i}]`
    if (pair.kind !== 'seq' || pair.items.length !== 2 || !isString(pair.items[0]) || !isOperator(pair.items[0].value)) refuse(`${here} is no requirement as RubyGems writes one`, where)
    return [pair.items[0].value, version(pair.items[1], `${here}[1]`, where)]
  })
  return pairs.length === 0 ? DEFAULT : pairs
}

// Its runtime dependencies, as Gem::Specification#runtime_dependencies;
// verify_spec refuses another type, and a name with a line break or `<>`.
function dependencies(node, where) {
  if (isNull(node)) return []
  if (node.kind !== 'seq') refuse('dependencies is no list', where)
  const runtime = []
  for (const [i, item] of node.items.entries()) {
    const field = `dependencies[${i}]`
    const entries = tagged(item, 'Dependency', field, where)
    const name = string(entries.get('name'), `${field}.name`, where)
    if (LINE_BREAK.test(name) || /[<>]/u.test(name)) refuse(`${field}.name ${quote(name)} is one RubyGems refuses to install`, where)
    // Gem::Dependency#type is :runtime where it is nil.
    const type = isNull(entries.get('type')) ? ':runtime' : entries.get('type').value
    if (!isNull(entries.get('type')) && (entries.get('type').type !== 'symbol' || ![':runtime', ':development'].includes(type))) refuse(`${field}.type is neither :runtime nor :development, which RubyGems refuses to install`, where)
    // #requirement, or where it is nil, the legacy version_requirements.
    if (entries.has('version_requirement')) refuse(`${field} has a version_requirement, which RubyGems reads as of old`, where)
    const required = isNull(entries.get('requirement')) ? entries.get('version_requirements') : entries.get('requirement')
    if (isNull(required)) refuse(`${field} has no requirement`, where)
    if (type === ':runtime') runtime.push({ name, requirements: requirement(required, `${field}.requirement`, where) })
  }
  return runtime
}

function metadata(node, where) {
  if (isNull(node)) return new Map()
  if (node.kind !== 'map') refuse('metadata is no mapping', where)
  return node.entries
}

// `name`, `version` and `platform` as written, which RubyGems names its
// directory and its file by; `extensions`, `executables` and `bindir` as
// an install takes them, a field left null at its default.
export function readSpec(text, where) {
  const root = parsePsych(text, where)
  const fields = tagged(root, 'Specification', 'the metadata', where)
  for (const key of fields.keys()) if (!/^[a-z_]\w*$/u.test(key)) refuse(`${quote(key)}, which RubyGems sets no attribute of`, where)
  const name = string(fields.get('name'), 'name', where)
  if (!isName(name)) refuse(`name ${quote(name)} is one RubyGems refuses to install`, where)
  const platform = isNull(fields.get('platform')) ? 'ruby' : string(fields.get('platform'), 'platform', where)
  if (platform !== 'ruby' && parsePlatform(platform) === undefined) refuse(`platform ${quote(platform)} is not one as RubyGems writes one`, where)
  // verify_spec holds its to_s to digits; nil is -1 there.
  const specVersion = fields.get('specification_version')
  if (specVersion?.kind !== 'scalar' || !['integer', 'string'].includes(specVersion.type) || !/^\d+$/u.test(specVersion.value)) refuse('specification_version is not a number, which RubyGems refuses to install', where)
  const requirePaths = isNull(fields.get('require_paths')) ? ['lib'] : strings(fields.get('require_paths'), 'require_paths', where)
  const extensions = strings(fields.get('extensions'), 'extensions', where)
  for (const [field, list] of [['require_paths', requirePaths], ['extensions', extensions]]) {
    if (list.some((item) => LINE_BREAK.test(item))) refuse(`${field} has a line break, which RubyGems refuses to install`, where)
  }
  const homepage = fields.get('homepage')
  const source = metadata(fields.get('metadata'), where).get('source_code_uri')
  return {
    name,
    version: version(fields.get('version'), 'version', where),
    platform,
    extensions,
    executables: strings(fields.get('executables'), 'executables', where),
    bindir: isNull(fields.get('bindir')) ? 'bin' : string(fields.get('bindir'), 'bindir', where),
    dependencies: dependencies(fields.get('dependencies'), where),
    requiredRuby: requirement(fields.get('required_ruby_version'), 'required_ruby_version', where),
    requiredRubygems: requirement(fields.get('required_rubygems_version'), 'required_rubygems_version', where),
    homepage: isString(homepage) ? homepage.value : undefined,
    sourceCodeUri: isString(source) ? source.value : undefined,
  }
}

// checksums.yaml: each algorithm's hex digest of each file of the .gem.
export function readChecksums(text, where) {
  const root = parsePsych(text, where)
  if (root.kind !== 'map' || root.tag !== undefined) refuse('it is no mapping of algorithms', where)
  const checksums = new Map()
  for (const [algorithm, files] of root.entries) {
    if (files.kind !== 'map' || files.tag !== undefined) refuse(`${quote(algorithm)} is no mapping of files`, where)
    checksums.set(algorithm, new Map([...files.entries].map(([file, digest]) => [file, string(digest, `${algorithm}.${file}`, where)])))
  }
  return checksums
}
