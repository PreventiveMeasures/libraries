// CocoaPods itself as the reference, from the cocoapods gem: what Ruby's
// File.fnmatch makes of a pattern and a path, what PathList expands a
// pattern's braces to, what of a download PodDirCleaner keeps, in its
// cache for every spec and then in Pods/ for those installed, its source
// files made read-only as lock_files! makes them, and what RemoteFile makes
// of an archive by :http, extracted with `tar xf` and flattened; all in one
// Ruby process. As root, GNU tar is told to extract as any other user does,
// by TAR_OPTIONS, which bsdtar does not read.
// RUBY names the interpreter, ruby by default, which finds the gem where
// gem does, by GEM_PATH among others; undefined comes back where either is
// missing.
import { spawnSync } from 'node:child_process'

const SCRIPT = String.raw`
require 'json'
require 'base64'
require 'tmpdir'
require 'fileutils'
require 'cocoapods'
File.umask(0o022)
include Pod

def fnmatch(pair)
  File.fnmatch(pair[0], pair[1], File::FNM_CASEFOLD | File::FNM_PATHNAME)
end

def expand(pattern)
  Sandbox::PathList.new(Pathname.new('/')).send(:dir_glob_equivalent_patterns, pattern)
end

# A download as entries [path, type, mode, data or target], cleaned in the
# cache, copied into Pods/, cleaned for the specs installed and locked.
def install(c)
  Dir.mktmpdir do |tmp|
    root = Pathname.new(tmp).realpath + 'download'
    root.mkpath
    c['entries'].each do |path, type, mode, value|
      at = root + path
      at.dirname.mkpath
      case type
      when 'directory' then at.mkpath
      when 'file' then File.binwrite(at, Base64.decode64(value)); File.chmod(mode, at)
      when 'symlink' then File.symlink(value, at)
      end
    end
    spec = Specification.from_json(c['podspec'])
    every = {}
    [spec, *spec.recursive_subspecs].each { |s| s.available_platforms.each { |p| (every[p] ||= []) << s } }
    Sandbox::PodDirCleaner.new(root, every).clean!
    pod = Pathname.new(tmp).realpath + 'Pods' + spec.name
    pod.parent.mkpath
    FileUtils.cp_r(root, pod)
    installed = {}
    c['installed'].each { |name| s = spec.subspec_by_name(name, true, true); s.available_platforms.each { |p| (installed[p] ||= []) << s } }
    Sandbox::PodDirCleaner.new(pod, installed).clean!
    accessors = installed.flat_map { |p, specs| specs.map { |s| Sandbox::FileAccessor.new(Sandbox::PathList.new(pod), s.consumer(p)) } }
    FileUtils.chmod('u-w', accessors.flat_map(&:source_files).reject { |f| (File.stat(f).mode & 0o200).zero? })
    entries = Dir.glob('**/*', File::FNM_DOTMATCH, base: pod.to_s).reject { |x| x == '.' || x.end_with?('/.') }.map do |x|
      st = File.lstat(pod + x)
      if st.symlink? then [x, 'symlink', File.readlink(pod + x)]
      elsif st.directory? then [x, 'directory']
      else [x, 'file', st.mode & 0o7777] end
    end
    { 'entries' => entries }
  end
rescue StandardError => e
  { 'error' => e.class.name }
end

def listing(root)
  Dir.glob('**/*', File::FNM_DOTMATCH, base: root.to_s).reject { |x| x == '.' || x.end_with?('/.') }.map do |x|
    st = File.lstat(root + x)
    if st.symlink? then [x, 'symlink', File.readlink(root + x)]
    elsif st.directory? then [x, 'directory']
    else [x, 'file', st.mode & 0o7777] end
  end
end

# An archive saved as RemoteFile saves it, then extracted and flattened by
# its own extract_with_type, as Http#download! leaves it.
def extract(c)
  Dir.mktmpdir do |tmp|
    root = Pathname.new(tmp).realpath + 'download'
    root.mkpath
    file = root + "file.#{c['type']}"
    File.binwrite(file, Base64.decode64(c['archive']))
    options = { :type => c['type'] }
    options[:flatten] = c['flatten'] if c.key?('flatten')
    http = Downloader::Http.new(root, 'https://github.com/acme/pod/archive/x', options)
    http.instance_variable_set(:@filename, file.basename.to_s)
    http.send(:extract_with_type, file, c['type'].to_sym)
    { 'entries' => listing(root) }
  end
rescue StandardError => e
  { 'error' => e.class.name }
end

input = JSON.parse(STDIN.read)
puts JSON.generate({
  'fnmatch' => input['fnmatch'].map { |pair| fnmatch(pair) },
  'expand' => input['expand'].map { |pattern| expand(pattern) },
  'install' => input['install'].map { |c| install(c) },
  'extract' => (input['extract'] || []).map { |c| extract(c) },
})
`

const asUser = process.getuid?.() === 0 ? { TAR_OPTIONS: '--no-same-permissions --no-same-owner' } : {}
const run = (input) => spawnSync(process.env.RUBY ?? 'ruby', ['-e', SCRIPT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, LANG: 'C.UTF-8', ...asUser }, maxBuffer: 1 << 28 })

export function cocoapodsVersion() {
  const r = spawnSync(process.env.RUBY ?? 'ruby', ['-e', "require 'cocoapods'; print Pod::VERSION"], { encoding: 'utf8' })
  return r.status === 0 && r.error === undefined ? r.stdout : undefined
}

export function cocoapods(input) {
  const r = run(input)
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}
