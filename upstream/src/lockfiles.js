// Each tool that writes a lockfile, by the format of it: the names it
// writes one under, and those of the project files it locks, each a name
// as git has it, `cargo.lock` not Cargo's, or a pattern. A lockfile's
// pattern names in a `locks` group the file beside it that it locks, where
// no name of that file's own tells it is one.
export const FORMATS = {
  // pnpm-lock.<branch>.yaml with git-branch-lockfile; shrinkwrap.yaml before
  // pnpm 3. package.yaml and package.json5 in place of package.json, and
  // .pnpmfile's hooks, which change what is locked.
  pnpm: {
    lockfiles: ['pnpm-lock.yaml', /^pnpm-lock\..+\.yaml$/u, 'shrinkwrap.yaml'],
    projects: ['package.json', 'package.yaml', 'package.json5', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.pnpmfile.mjs'],
  },
  // npm-shrinkwrap.json is npm's own format, which npm reads before a
  // package-lock.json beside it.
  npm: { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], projects: ['package.json'] },
  // Of Yarn 1 or a later Yarn, which only the text tells apart. .yarnrc.yml
  // has Yarn 4's catalogs.
  yarn: { lockfiles: ['yarn.lock'], projects: ['package.json', '.yarnrc.yml'] },
  // bun.lockb is Bun's binary one, before Bun 1.2.
  bun: { lockfiles: ['bun.lock', 'bun.lockb'], projects: ['package.json'] },
  deno: { lockfiles: ['deno.lock'], projects: ['deno.json', 'deno.jsonc', 'package.json'] },
  // <script>.py.lock, of `uv lock --script`, which locks the script.
  uv: { lockfiles: ['uv.lock', /^(?<locks>.+\.py)\.lock$/u], projects: ['pyproject.toml'] },
  poetry: { lockfiles: ['poetry.lock'], projects: ['pyproject.toml'] },
  // PEP 751's.
  pylock: { lockfiles: ['pylock.toml', /^pylock\.[^.]+\.toml$/u], projects: ['pyproject.toml'] },
  pipenv: { lockfiles: ['Pipfile.lock'], projects: ['Pipfile'] },
  pdm: { lockfiles: ['pdm.lock'], projects: ['pyproject.toml'] },
  pixi: { lockfiles: ['pixi.lock'], projects: ['pixi.toml', 'pyproject.toml'] },
  // A unified lockfile of another name has to end in `.conda-lock.yml`; the
  // explicit and env ones are conda-<platform>.lock and .lock.yml. A
  // conda-build recipe, meta.yaml, is a source too.
  'conda-lock': {
    lockfiles: ['conda-lock.yml', 'conda-lock.yaml', /^.+\.conda-lock\.yml$/u, /^conda-[\da-z]+-[\da-z]+\.lock(?:\.yml)?$/u],
    projects: ['environment.yml', 'environment.yaml', 'meta.yaml', 'pyproject.toml'],
  },
  // A gemspec, whose dependencies a Gemfile's `gemspec` takes.
  bundler: { lockfiles: ['Gemfile.lock', 'gems.locked'], projects: ['Gemfile', 'gems.rb', /^.+\.gemspec$/u] },
  composer: { lockfiles: ['composer.lock'], projects: ['composer.json'] },
  cargo: { lockfiles: ['Cargo.lock'], projects: ['Cargo.toml'] },
  soldeer: { lockfiles: ['soldeer.lock'], projects: ['soldeer.toml', 'foundry.toml'] },
  foundry: { lockfiles: ['foundry.lock'], projects: ['foundry.toml'] },
  // Each name CocoaPods reads a Podfile under, and a podspec, whose
  // dependencies a Podfile's `podspec` takes.
  cocoapods: { lockfiles: ['Podfile.lock'], projects: ['Podfile', 'Podfile.rb', 'CocoaPods.podfile', 'CocoaPods.podfile.yaml', /^.+\.podspec(?:\.json)?$/u] },
  swiftpm: { lockfiles: ['Package.resolved'], projects: ['Package.swift', /^Package@swift-\d+(?:\.\d+){0,2}\.swift$/u] },
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
  // Any *.lockfile: Gradle's own, the legacy one of each configuration, or
  // one a build names. Version catalogs, libs.versions.toml and the like.
  gradle: { lockfiles: [/^.+\.lockfile$/u], projects: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', /^.+\.versions\.toml$/u] },
  // pubspec_overrides.yaml overrides pubspec.yaml's dependency_overrides,
  // workspace and resolution.
  pub: { lockfiles: ['pubspec.lock'], projects: ['pubspec.yaml', 'pubspec_overrides.yaml'] },
  mix: { lockfiles: ['mix.lock'], projects: ['mix.exs'] },
  // rebar.config.script, where there is one, makes the configuration.
  rebar: { lockfiles: ['rebar.lock'], projects: ['rebar.config', 'rebar.config.script'] },
  julia: { lockfiles: ['Manifest.toml', 'JuliaManifest.toml', /^(?:Julia)?Manifest-v\d+\.\d+\.toml$/u], projects: ['Project.toml', 'JuliaProject.toml'] },
  stack: { lockfiles: ['stack.yaml.lock'], projects: ['stack.yaml'] },
  cabal: { lockfiles: ['cabal.project.freeze'], projects: ['cabal.project', /^.+\.cabal$/u] },
  shards: { lockfiles: ['shard.lock'], projects: ['shard.yml', 'shard.override.yml'] },
  opam: { lockfiles: ['opam.locked', /^.+\.opam\.locked$/u], projects: ['opam', /^.+\.opam$/u] },
  nix: { lockfiles: ['flake.lock'], projects: ['flake.nix'] },
  conan: { lockfiles: ['conan.lock'], projects: ['conanfile.txt', 'conanfile.py'] },
  // <name>.MODULE.bazel, which MODULE.bazel's include() takes.
  bazel: { lockfiles: ['MODULE.bazel.lock'], projects: ['MODULE.bazel', /^[^.].*\.MODULE\.bazel$/u] },
  helm: { lockfiles: ['Chart.lock'], projects: ['Chart.yaml'] },
  // Of no project file, but the library it is made from.
  renv: { lockfiles: ['renv.lock'], projects: [] },
  // Of the configuration in the directory, each of its .tf files, a child
  // module's too, of which there is none; OpenTofu's .tofu files, and a
  // Stack's components.
  terraform: { lockfiles: ['.terraform.lock.hcl'], projects: [/^.+\.(?:tf|tofu)(?:\.json)?$/u, /^.+\.tfcomponent\.hcl$/u] },
}

const TOOLS = Object.entries(FORMATS)
const KNOWN = TOOLS.flatMap(([, { lockfiles, projects }]) => [...lockfiles, ...projects])

// A name of none of them, as most in a repository are, is passed over at
// once, by a set of the names and one pattern of all the patterns.
const NAMES = new Set(KNOWN.filter((known) => typeof known === 'string'))
const PATTERN = new RegExp(KNOWN.filter((known) => typeof known !== 'string').map(({ source }) => `(?:${source})`).join('|'), 'u')
const isKnown = (name) => NAMES.has(name) || PATTERN.test(name)

// Whether `name` is one of `names`, each a name or a pattern.
const isOf = (names, name) => names.some((known) => (typeof known === 'string' ? known === name : known.test(name)))

// The lockfile a file of this name is, `{ format, locks }`, `locks` the name
// of the file beside it that it locks where its pattern names one; or
// undefined.
export function lockfileOf(name) {
  for (const [format, { lockfiles }] of isKnown(name) ? TOOLS : []) {
    for (const known of lockfiles) {
      const match = typeof known === 'string' ? known === name && {} : known.exec(name)
      if (match) return { format, locks: match.groups?.locks }
    }
  }
}

// The formats of the lockfiles that lock a project of a file of this name,
// in FORMATS' order, none where it is no project file.
export const projectFormats = (name) => (isKnown(name) ? TOOLS.filter(([, { projects }]) => isOf(projects, name)).map(([format]) => format) : [])
