// RubyGems and Bundler themselves as the reference, in one Ruby process:
// what Bundler's own installer, Bundler::RubyGemsGemInstaller, leaves of a
// .gem in a gem's directory, as `bundle install` runs it, under a umask of
// 0o022; what Gem::Specification.from_yaml reads of a spec's YAML; and
// specs made at random and written by Gem::Specification#to_yaml, with
// what each reads back as. RUBY names the interpreter, ruby by default;
// undefined comes back where it or Bundler is missing.
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const SCRIPT = String.raw`
require 'json'
require 'base64'
require 'tmpdir'
require 'bundler'
require 'bundler/rubygems_gem_installer'
File.umask(0o022)

def listing(root)
  Dir.glob('**/*', File::FNM_DOTMATCH, base: root).reject { |x| x == '.' || x.end_with?('/.') }.sort.map do |x|
    st = File.lstat(File.join(root, x))
    if st.symlink? then [x, 'symlink', File.readlink(File.join(root, x))]
    elsif st.directory? then [x, 'directory', st.mode & 0o7777]
    else [x, 'file', st.mode & 0o7777] end
  end
end

def install(gem)
  Dir.mktmpdir do |tmp|
    path = File.join(tmp, 'x.gem')
    File.binwrite(path, Base64.decode64(gem))
    home = File.join(tmp, 'home')
    installer = Bundler::RubyGemsGemInstaller.at(path, install_dir: home, bin_dir: File.join(home, 'bin'), ignore_dependencies: true, wrappers: true, env_shebang: true)
    spec = installer.install
    { 'entries' => listing(File.join(home, 'gems', spec.full_name)) }
  end
rescue StandardError, ScriptError => e
  { 'error' => e.class.name }
end

def strings(value)
  case value
  when String then value.encoding == Encoding::BINARY || !value.valid_encoding? ? { 'binary' => Base64.strict_encode64(value) } : value
  when Array then value.map { |v| strings(v) }
  when Hash then value.to_h { |k, v| [k.to_s, strings(v)] }
  when nil then nil
  else value.to_s
  end
end

def read(yaml)
  spec = Gem::Specification.from_yaml(yaml)
  {
    'name' => spec.name, 'version' => spec.version.to_s, 'platform' => spec.platform.to_s,
    'summary' => strings(spec.summary), 'description' => strings(spec.description), 'authors' => strings(spec.authors),
    'files' => strings(spec.instance_variable_get(:@files)), 'executables' => strings(spec.executables), 'post_install_message' => strings(spec.post_install_message),
    'metadata' => strings(spec.metadata), 'homepage' => strings(spec.homepage),
    'dependencies' => spec.runtime_dependencies.map { |d| [d.name, d.requirement.requirements.map { |op, v| [op, v.to_s] }] },
  }
rescue StandardError, ScriptError => e
  { 'error' => e.class.name }
end

PALETTE = ['a', 'b', 'Z', '0', '1', ' ', ' ', '  ', ':', ': ', '#', ' #', '-', '- ', '?', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', "'", '"', '%', '@', "\x60", '\\', '/', "\n", "\n", "\n\n", "\t", "\u00e9", "\u4e2d", "\u{1F600}", "\u00a0", "\u2028", "\u0085", "\e", "\x01", 'yes', 'no', 'null', '~', '1.0', '0x1', ':sym', 'word ' * 12, '---', '...']

def random_string(r)
  (0...r.rand(0..14)).map { PALETTE[r.rand(PALETTE.size)] }.join
end

def random_specs(seed, count)
  r = Random.new(seed)
  (0...count).map do |i|
    spec = Gem::Specification.new do |s|
      s.name = "gem#{i}"
      s.version = "1.#{r.rand(10)}.0"
      s.summary = random_string(r)
      s.description = random_string(r) * r.rand(1..8)
      s.authors = (0...r.rand(0..3)).map { random_string(r) }
      s.files = (0...r.rand(0..3)).map { random_string(r) } + (r.rand(4).zero? ? ["\xff\xfe".b] : [])
      s.executables = (0...r.rand(0..2)).map { random_string(r) }
      s.post_install_message = random_string(r) * r.rand(1..20) if r.rand(2).zero?
      s.homepage = random_string(r) if r.rand(2).zero?
      s.metadata = (0...r.rand(0..3)).to_h { [random_string(r), random_string(r)] }
      (0...r.rand(0..2)).each { |k| s.add_dependency "dep#{k}", ['~> 1.0', '>= 0.5', '< 3', '!= 2.1.a'].sample(r.rand(1..2), random: r) }
    end
    yaml = spec.to_yaml
    { 'yaml' => yaml, 'read' => read(yaml) }
  end
end

input = JSON.parse(STDIN.read)
puts JSON.generate({
  'install' => (input['install'] || []).map { |gem| install(gem) },
  'read' => (input['read'] || []).map { |yaml| read(yaml) },
  'specs' => input['specs'] ? random_specs(input['specs']['seed'], input['specs']['count']) : [],
})
`

const run = (input) => spawnSync(process.env.RUBY ?? 'ruby', ['-e', SCRIPT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, LANG: 'C.UTF-8' }, maxBuffer: 1 << 28 })

export function bundlerVersion() {
  const r = spawnSync(process.env.RUBY ?? 'ruby', ['-e', "require 'bundler'; print Bundler::VERSION, ' ', Gem::VERSION, ' ', RUBY_VERSION, ' ', Gem::Platform.local, ' ', RUBY_ENGINE"], { encoding: 'utf8' })
  if (r.status !== 0 || r.error !== undefined) return undefined
  const [bundler, rubygems, ruby, platform, engine] = r.stdout.split(' ')
  return { bundler, rubygems, ruby, platform, engine }
}

export function reference(input) {
  const r = run(input)
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}
