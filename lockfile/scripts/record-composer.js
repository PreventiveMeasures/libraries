// Records what Composer writes for the projects below into
// tests/composer/fixtures/, each composer.lock as <name>.lock, beside the
// composer.json it was written for as <name>.json. Needs php,
// git, and network access to getcomposer.org, which each Composer is taken
// from, and to repo.packagist.org; nothing is installed, so GitHub is not
// asked for anything:
//
//     node lockfile/scripts/record-composer.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what Composer says as it runs.
//
// The project asks for every kind of package a lockfile records: a
// directory by a path repository, with a bin, which Composer gives
// transport-options; a git repository beside it, at its default branch,
// with a branch alias, and asked for under an alias of the root's; a
// package defined inline, from a zip with a sha1 and a git tag; and
// Packagist's, among them one that provides a platform package, one that
// replaces another at self.version, one with conflicts; and as dev
// requirements, one abandoned for another, one abandoned for none, asked
// for at @stable, and one at @beta. It asks for the platform too, in
// require and require-dev, and overrides PHP's version. Composer 2.10,
// 2.8, 2.7, 2.2 and 2.0 lock it, each with its plugin-api-version: 2.8 and
// later sort stability-flags, which 2.7 and older write in the order the
// root asks, and write `{}` where those write `[]`, as the empty ones show.
//
// The empty project asks for nothing: Composer 2.10's and 2.2's. The tabs
// project is the empty one indented with a tab, then asked for a package
// by `composer require`, which Composer 2.6 and later write in the
// indentation of the lockfile they rewrite.
//
// The git repository is committed at a fixed time, by a fixed author, so
// its commit is the same each run; Packagist's packages are what it has
// that day.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/composer/fixtures/', import.meta.url))

const quiet = process.env.VERBOSE ? 'inherit' : 'ignore'
const run = (command, args, options) => execFileSync(command, args, { stdio: ['ignore', quiet, quiet], ...options })

function write(dir, name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 4)}\n`)
}

const LOCAL = {
  name: 'fixture/local',
  description: 'A package by a path repository.',
  version: '1.2.0',
  type: 'library',
  license: 'MIT',
  require: { php: '>=8.1', 'psr/log': '^3.0' },
  autoload: { 'psr-4': { 'Fixture\\Local\\': 'src/' } },
  bin: ['bin/local'],
}

const VCS = {
  name: 'fixture/vcs',
  description: 'A package by a git repository.',
  require: { 'psr/log': '^2.0 || ^3.0' },
  extra: { 'branch-alias': { 'dev-main': '1.0.x-dev' } },
  autoload: { classmap: ['src/'] },
}

const INLINE = {
  name: 'fixture/inline',
  version: '2.0.0',
  dist: { type: 'zip', url: 'https://example.com/inline-2.0.0.zip', shasum: '0123456789abcdef0123456789abcdef01234567' },
  source: { type: 'git', url: 'https://example.com/inline.git', reference: 'v2.0.0' },
  require: { php: '>=7.4' },
}

const PROJECT = {
  name: 'fixture/project',
  description: 'Every kind of package a lockfile records.',
  'minimum-stability': 'stable',
  'prefer-stable': true,
  repositories: [
    { type: 'path', url: './packages/local' },
    { type: 'vcs', url: './repos/vcs' },
    { type: 'package', package: INLINE },
  ],
  require: {
    php: '>=8.1',
    'ext-json': '*',
    'fixture/inline': '^2.0',
    'fixture/local': '*',
    'fixture/vcs': 'dev-main as 1.1.0',
    'guzzlehttp/guzzle': '^7.8',
    'monolog/monolog': '^3.0',
    'ramsey/uuid': '^4.7',
    'symfony/polyfill-mbstring': '^1.30',
  },
  'require-dev': {
    'doctrine/cache': '^2.2@stable',
    'ext-mbstring': '*',
    'php-http/message-factory': '^1.1',
    'symfony/var-dumper': '^7.0@beta',
  },
  config: { platform: { php: '8.3.0' } },
}

const EMPTY = { name: 'fixture/empty', description: 'Asks for nothing.' }

// A git repository of one commit, at a time and by an author that do not
// change.
function commit(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
  run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir })
  run('git', ['add', '--all'], { cwd: dir })
  run('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message=init'], { cwd: dir, env })
}

function layProject(dir) {
  write(dir, 'composer.json', PROJECT)
  write(dir, 'packages/local/composer.json', LOCAL)
  write(dir, 'packages/local/bin/local', '#!/usr/bin/env php\n')
  write(dir, 'repos/vcs/composer.json', VCS)
  write(dir, 'repos/vcs/src/Vcs.php', '<?php\n')
  commit(join(dir, 'repos/vcs'))
}

const UPDATE = ['update', '--no-install', '--no-interaction', '--no-plugins', '--no-scripts']

const RUNS = [
  { name: 'composer-2.10.3', composer: '2.10.3', lay: layProject },
  { name: 'composer-2.8.12', composer: '2.8.12', lay: layProject },
  { name: 'composer-2.7.9', composer: '2.7.9', lay: layProject },
  { name: 'composer-2.2.30', composer: '2.2.30', lay: layProject },
  { name: 'composer-2.0.14', composer: '2.0.14', lay: layProject },
  { name: 'composer-2.10.3-empty', composer: '2.10.3', lay: (dir) => write(dir, 'composer.json', EMPTY) },
  { name: 'composer-2.2.30-empty', composer: '2.2.30', lay: (dir) => write(dir, 'composer.json', EMPTY) },
  {
    name: 'composer-2.10.3-tabs',
    composer: '2.10.3',
    lay: (dir) => write(dir, 'composer.json', EMPTY),
    // The lockfile indented with a tab, as an editor may leave it, and
    // rewritten by `composer require`.
    after: (dir, composer) => {
      const lock = join(dir, 'composer.lock')
      writeFileSync(lock, readFileSync(lock, 'utf8').replaceAll(/^(?: {4})+/gmu, (spaces) => '\t'.repeat(spaces.length / 4)))
      composer('require', '--no-install', '--no-interaction', '--no-plugins', '--no-scripts', 'psr/container:^2.0')
    },
  },
]

const only = process.argv.slice(2)

for (const entry of RUNS.filter(({ name }) => only.length === 0 || only.includes(name))) {
  const top = mkdtempSync(join(tmpdir(), `${entry.name}-`))
  const dir = join(top, 'project')
  const phar = join(top, 'composer.phar')
  const env = { ...process.env, COMPOSER_HOME: join(top, 'home'), COMPOSER_CACHE_DIR: join(top, 'cache'), COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_AUDIT: '1' }
  const composer = (...args) => run('php', [phar, ...args], { cwd: dir, env })
  try {
    run('curl', ['--silent', '--show-error', '--fail', '--location', '--output', phar, `https://getcomposer.org/download/${entry.composer}/composer.phar`])
    mkdirSync(dir)
    entry.lay(dir)
    composer(...UPDATE)
    entry.after?.(dir, composer)
    write(OUT, `${entry.name}.lock`, readFileSync(join(dir, 'composer.lock'), 'utf8'))
    write(OUT, `${entry.name}.json`, readFileSync(join(dir, 'composer.json'), 'utf8'))
  } finally {
    rmSync(top, { recursive: true, force: true })
  }
}
