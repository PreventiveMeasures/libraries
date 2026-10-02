// CocoaPods itself as the reference, from cocoapods-core: what YAMLHelper
// writes of a tree of values and what Psych reads back of it, what Psych
// makes of a plain scalar, what Dependency#to_s writes of an external
// source, and what Pod::Lockfile reads of a lockfile; all in one Ruby
// process. RUBY names the interpreter, ruby by
// default, which finds cocoapods-core where gem does, by GEM_PATH among
// others; undefined comes back where either is missing.
import { spawnSync } from 'node:child_process'

const SCRIPT = String.raw`
require 'json'
require 'yaml'
require 'cocoapods-core'

# A tree as JSON, tagged: {"s": string}, {"y": symbol}, {"b": boolean},
# {"a": [items]} and {"m": [[key, value]]}, and anything else as its class.
def build(node)
  return node['s'] if node.key?('s')
  return node['y'].to_sym if node.key?('y')
  return node['b'] if node.key?('b')
  return node['a'].map { |item| build(item) } if node.key?('a')
  node['m'].each_with_object({}) { |(key, value), hash| hash[build(key)] = build(value) }
end

def tag(value)
  case value
  when String then { 's' => value }
  when Symbol then { 'y' => value.to_s }
  when true, false then { 'b' => value }
  when Array then { 'a' => value.map { |item| tag(item) } }
  when Hash then { 'm' => value.map { |key, item| [tag(key), tag(item)] } }
  else { 'x' => value.class.name }
  end
end

def emit(tree)
  hash = build(tree)
  text = Pod::YAMLHelper.convert_hash(hash, Pod::Lockfile::HASH_KEY_ORDER, "\n\n")
  begin
    read = Pod::YAMLHelper.load_string(text)
    { 'text' => text, 'read' => tag(read), 'same' => read == hash }
  rescue Exception
    { 'text' => text, 'read' => nil, 'same' => false }
  end
end

LOADER = Psych::ClassLoader::Restricted.new(%w[Date Time Symbol], [])
def psych(text)
  value = Psych::ScalarScanner.new(LOADER).tokenize(text)
  value.class.name
rescue Exception => error
  error.class.name
end

def describe(pair)
  Pod::Dependency.new(pair[0], build(pair[1])).to_s
end

# What Pod::Lockfile reads of a lockfile, by its accessors.
def lockfile(text)
  lockfile = Pod::Lockfile.new(Pod::YAMLHelper.load_string(text))
  roots = lockfile.pod_names.map { |name| name.split('/').first }.uniq
  {
    'pods' => lockfile.pod_names.to_h { |name| [name, lockfile.version(name).to_s] },
    'dependencies' => lockfile.dependencies.map { |dependency| [dependency.name, dependency.external? ? nil : dependency.requirement.to_s, dependency.external?] },
    'repos' => roots.to_h { |root| [root, lockfile.spec_repo(root)] },
    'checksums' => roots.to_h { |root| [root, lockfile.checksum(root)] },
    'checkouts' => roots.to_h { |root| [root, lockfile.checkout_options_for_pod_named(root)&.to_h { |key, value| [key.to_s, value] }] },
    'cocoapods' => lockfile.cocoapods_version.to_s,
  }
end

KINDS = { 'emit' => method(:emit), 'lockfile' => method(:lockfile), 'psych' => method(:psych), 'describe' => method(:describe), 'version' => ->(_) { Pod::CORE_VERSION } }
results = JSON.parse($stdin.read).map do |kind, input|
  { 'value' => KINDS[kind].call(input) }
rescue Exception => error
  { 'error' => error.class.name }
end
$stdout.write(JSON.generate(results))
`

// Each case is [kind, input]; each result { value } or { error }.
export function cocoapods(cases) {
  const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
  const run = spawnSync(process.env.RUBY ?? 'ruby', ['-e', SCRIPT], { input: JSON.stringify(cases), encoding: 'utf8', env, maxBuffer: 1 << 28 })
  if (run.error !== undefined || run.status !== 0) return undefined
  return JSON.parse(run.stdout)
}

export const coreVersion = () => cocoapods([['version', null]])?.[0]?.value
