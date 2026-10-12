// Each tool that writes a lockfile, by the format of it: the names it
// writes one under, and those of the project files it locks, each a name
// as git has it, `cargo.lock` not Cargo's, or a pattern. The formats
// @preventive/lockfile reads go by the names of the modules that do.
const FORMATS = {
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
  'conda-lock': { lockfiles: ['conda-lock.yml'], projects: ['environment.yml', 'environment.yaml'] },
  bundler: { lockfiles: ['Gemfile.lock', 'gems.locked'], projects: ['Gemfile', 'gems.rb'] },
  composer: { lockfiles: ['composer.lock'], projects: ['composer.json'] },
  cargo: { lockfiles: ['Cargo.lock'], projects: ['Cargo.toml'] },
  soldeer: { lockfiles: ['soldeer.lock'], projects: ['soldeer.toml', 'foundry.toml'] },
  foundry: { lockfiles: ['foundry.lock'], projects: ['foundry.toml'] },
  cocoapods: { lockfiles: ['Podfile.lock'], projects: ['Podfile'] },
  swiftpm: { lockfiles: ['Package.resolved'], projects: ['Package.swift'] },
  carthage: { lockfiles: ['Cartfile.resolved'], projects: ['Cartfile', 'Cartfile.private'] },
  // go.sum has the checksums; go.mod, the versions, is locked as it is.
  go: { lockfiles: ['go.sum'], projects: ['go.mod'] },
  dep: { lockfiles: ['Gopkg.lock'], projects: ['Gopkg.toml'] },
  nuget: { lockfiles: ['packages.lock.json'], projects: [/^.+\.(?:cs|fs|vb)proj$/u] },
  paket: { lockfiles: ['paket.lock'], projects: ['paket.dependencies'] },
  gradle: { lockfiles: ['gradle.lockfile', 'buildscript-gradle.lockfile', 'settings-gradle.lockfile'], projects: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  pub: { lockfiles: ['pubspec.lock'], projects: ['pubspec.yaml'] },
  mix: { lockfiles: ['mix.lock'], projects: ['mix.exs'] },
  rebar: { lockfiles: ['rebar.lock'], projects: ['rebar.config'] },
  julia: { lockfiles: ['Manifest.toml', 'JuliaManifest.toml', /^(?:Julia)?Manifest-v\d+\.\d+\.toml$/u], projects: ['Project.toml', 'JuliaProject.toml'] },
  stack: { lockfiles: ['stack.yaml.lock'], projects: ['stack.yaml'] },
  cabal: { lockfiles: ['cabal.project.freeze'], projects: ['cabal.project', /^.+\.cabal$/u] },
  shards: { lockfiles: ['shard.lock'], projects: ['shard.yml'] },
  opam: { lockfiles: ['opam.locked', /^.+\.opam\.locked$/u], projects: ['opam', /^.+\.opam$/u] },
  nix: { lockfiles: ['flake.lock'], projects: ['flake.nix'] },
  conan: { lockfiles: ['conan.lock'], projects: ['conanfile.txt', 'conanfile.py'] },
  bazel: { lockfiles: ['MODULE.bazel.lock'], projects: ['MODULE.bazel'] },
  helm: { lockfiles: ['Chart.lock'], projects: ['Chart.yaml'] },
  // Of no project file, but the library or the directory it is in.
  renv: { lockfiles: ['renv.lock'], projects: [] },
  terraform: { lockfiles: ['.terraform.lock.hcl'], projects: [] },
}

// Each format a name is of, those of the names first, in FORMATS' order.
function indexOf(kind) {
  const names = new Map()
  const patterns = []
  for (const [format, { [kind]: matching }] of Object.entries(FORMATS)) {
    for (const name of matching) {
      if (typeof name === 'string') names.set(name, [...names.get(name) ?? [], format])
      else patterns.push([name, format])
    }
  }
  return (name) => [...names.get(name) ?? [], ...patterns.filter(([pattern]) => pattern.test(name)).map(([, format]) => format)]
}

const lockfileFormats = indexOf('lockfiles')

// The format a file of this name is a lockfile of, or undefined.
export const lockfileFormat = (name) => lockfileFormats(name)[0]

// The formats of the lockfiles that lock a project of a file of this name,
// none where it is no project file.
export const projectFormats = indexOf('projects')
