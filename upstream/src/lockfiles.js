// Each tool that writes a lockfile, by the format of it: the names it
// writes one under, and those of the project files it locks, each a name
// as git has it, `cargo.lock` not Cargo's, or a pattern. The formats
// @preventive/lockfile reads go by the names of the modules that do.
export const FORMATS = {
  pnpm: { lockfiles: ['pnpm-lock.yaml'], projects: ['package.json', 'pnpm-workspace.yaml'] },
  // npm-shrinkwrap.json is npm's own format, which npm reads before a
  // package-lock.json beside it.
  npm: { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], projects: ['package.json'] },
  // Of Yarn 1 or a later Yarn, which only the text tells apart.
  yarn: { lockfiles: ['yarn.lock'], projects: ['package.json'] },
  // bun.lockb is Bun's binary one, before Bun 1.2.
  bun: { lockfiles: ['bun.lock', 'bun.lockb'], projects: ['package.json'] },
  deno: { lockfiles: ['deno.lock'], projects: ['deno.json', 'deno.jsonc', 'package.json'] },
  uv: { lockfiles: ['uv.lock'], projects: ['pyproject.toml'] },
  poetry: { lockfiles: ['poetry.lock'], projects: ['pyproject.toml'] },
  // PEP 751's: `pylock.toml`, or `pylock.<name>.toml`, the name with no dot.
  pylock: { lockfiles: ['pylock.toml', /^pylock\.[^.]+\.toml$/u], projects: ['pyproject.toml'] },
  pipenv: { lockfiles: ['Pipfile.lock'], projects: ['Pipfile'] },
  pdm: { lockfiles: ['pdm.lock'], projects: ['pyproject.toml'] },
  pixi: { lockfiles: ['pixi.lock'], projects: ['pixi.toml', 'pyproject.toml'] },
  // A unified lockfile of another name has to end in `.conda-lock.yml`.
  'conda-lock': { lockfiles: ['conda-lock.yml', 'conda-lock.yaml', /^.+\.conda-lock\.yml$/u], projects: ['environment.yml', 'environment.yaml'] },
  bundler: { lockfiles: ['Gemfile.lock', 'gems.locked'], projects: ['Gemfile', 'gems.rb'] },
  composer: { lockfiles: ['composer.lock'], projects: ['composer.json'] },
  cargo: { lockfiles: ['Cargo.lock'], projects: ['Cargo.toml'] },
  soldeer: { lockfiles: ['soldeer.lock'], projects: ['soldeer.toml', 'foundry.toml'] },
  foundry: { lockfiles: ['foundry.lock'], projects: ['foundry.toml'] },
  cocoapods: { lockfiles: ['Podfile.lock'], projects: ['Podfile'] },
  swiftpm: { lockfiles: ['Package.resolved'], projects: ['Package.swift'] },
  carthage: { lockfiles: ['Cartfile.resolved'], projects: ['Cartfile', 'Cartfile.private'] },
  // go.sum has the checksums; go.mod, the versions, is locked as it is. A
  // workspace's go.work.sum has those its modules' go.sum do not.
  go: { lockfiles: ['go.sum', 'go.work.sum'], projects: ['go.mod', 'go.work'] },
  dep: { lockfiles: ['Gopkg.lock'], projects: ['Gopkg.toml'] },
  // packages.<project>.lock.json, for one of projects that share a
  // directory; Directory.Packages.props has the versions of Central
  // Package Management, which the project files then leave out.
  nuget: { lockfiles: ['packages.lock.json', /^packages\..+\.lock\.json$/u], projects: [/^.+\.(?:cs|fs|vb)proj$/u, 'Directory.Packages.props'] },
  paket: { lockfiles: ['paket.lock'], projects: ['paket.dependencies'] },
  // gradle.lockfile, buildscript-gradle.lockfile and settings-gradle.lockfile;
  // the legacy one of each configuration, `<configuration>.lockfile`; and
  // one of the name and the place a build gives it, by its ending.
  gradle: { lockfiles: [/^.+\.lockfile$/u], projects: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  // pubspec_overrides.yaml overrides pubspec.yaml's dependency_overrides,
  // workspace and resolution.
  pub: { lockfiles: ['pubspec.lock'], projects: ['pubspec.yaml', 'pubspec_overrides.yaml'] },
  mix: { lockfiles: ['mix.lock'], projects: ['mix.exs'] },
  // rebar.config.script, where there is one, makes the configuration.
  rebar: { lockfiles: ['rebar.lock'], projects: ['rebar.config', 'rebar.config.script'] },
  julia: { lockfiles: ['Manifest.toml', 'JuliaManifest.toml', /^(?:Julia)?Manifest-v\d+\.\d+\.toml$/u], projects: ['Project.toml', 'JuliaProject.toml'] },
  stack: { lockfiles: ['stack.yaml.lock'], projects: ['stack.yaml'] },
  cabal: { lockfiles: ['cabal.project.freeze'], projects: ['cabal.project', /^.+\.cabal$/u] },
  shards: { lockfiles: ['shard.lock'], projects: ['shard.yml'] },
  opam: { lockfiles: ['opam.locked', /^.+\.opam\.locked$/u], projects: ['opam', /^.+\.opam$/u] },
  nix: { lockfiles: ['flake.lock'], projects: ['flake.nix'] },
  conan: { lockfiles: ['conan.lock'], projects: ['conanfile.txt', 'conanfile.py'] },
  bazel: { lockfiles: ['MODULE.bazel.lock'], projects: ['MODULE.bazel'] },
  helm: { lockfiles: ['Chart.lock'], projects: ['Chart.yaml'] },
  // Of no project file, but the library it is made from.
  renv: { lockfiles: ['renv.lock'], projects: [] },
  // Of the configuration in the directory, each of its .tf files, a child
  // module's too, of which there is none.
  terraform: { lockfiles: ['.terraform.lock.hcl'], projects: [/^.+\.tf$/u, /^.+\.tf\.json$/u] },
}

const TOOLS = Object.entries(FORMATS)

// Whether `name` is one of `names`, each a name or a pattern.
const isOf = (names, name) => names.some((known) => (typeof known === 'string' ? known === name : known.test(name)))

// The format a file of this name is a lockfile of, or undefined.
export const lockfileFormat = (name) => TOOLS.find(([, { lockfiles }]) => isOf(lockfiles, name))?.[0]

// The formats of the lockfiles that lock a project of a file of this name,
// in FORMATS' order, none where it is no project file.
export const projectFormats = (name) => TOOLS.filter(([, { projects }]) => isOf(projects, name)).map(([format]) => format)
