import assert from 'node:assert/strict'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { getGitHub, readPackageRepoCache, resolvePackageRepos, setCacheDir, writePackageRepoCache } from '../npm.js'

// A cache directory of this file's own: everything below is a real disk
// read or write, and it has to land somewhere nothing else reads.
const CACHE_DIR = join(tmpdir(), `upstream-npm-repos-test-${process.pid}`)
setCacheDir(CACHE_DIR)

const REPOS = join(CACHE_DIR, 'npm', 'repos')
const DAY = 24 * 60 * 60 * 1000

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
})

// What `registry.npmjs.org/<name>/latest` answers, reduced to the
// fields getGitHub reads. `calls` records every name asked for, which
// is what the cache is supposed to keep short.
function stubRegistry(payloads) {
  const calls = []
  globalThis.fetch = (url) => {
    const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', '').replace(/\/latest$/u, ''))
    calls.push(name)
    const body = payloads[name]
    if (!body) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    return Promise.resolve(Response.json({ name, ...body }))
  }
  return calls
}

// The shape most packages carry: an `/issues` tracker on the repo
// itself, with no `repository` to take first.
const tracked = (repo) => ({ bugs: { url: `https://github.com/${repo}/issues` }, homepage: `https://github.com/${repo}#readme` })

// getGitHub, against one package's registry document.
async function resolveOne(body) {
  stubRegistry({ pkg: body })
  return await getGitHub('pkg')
}

// The repo AND where in it the package sits, which is what a monorepo
// package needs for a link that lands on the package.
async function resolveRepo(body) {
  const { github, directory } = await resolveOne(body)
  return directory ? `${github} @ ${directory}` : github
}

describe('getGitHub — where in the repo the package sits', () => {
  it("takes npm's `repository.directory`", async () => {
    // @babel/core: babel/babel is hundreds of packages, and a link that
    // stops at the root lands on none of them.
    const body = { repository: { url: 'https://github.com/babel/babel.git', type: 'git', directory: 'packages/babel-core' } }
    assert.equal(await resolveRepo(body), 'babel/babel @ packages/babel-core')
  })

  it('takes it from a `homepage` pointing into the repo when npm has none', async () => {
    // @preventive/diff spells it exactly this way and sets no `directory`.
    const body = {
      homepage: 'https://github.com/PreventiveMeasures/libraries/tree/main/diff',
      repository: { url: 'git+https://github.com/PreventiveMeasures/libraries.git', type: 'git' },
      bugs: { url: 'https://github.com/PreventiveMeasures/libraries/issues' },
    }
    assert.equal(await resolveRepo(body), 'PreventiveMeasures/libraries @ diff')
  })

  it("prefers npm's field over the homepage, and strips npm's `#readme`", async () => {
    const repository = { url: 'https://github.com/acme/app.git', directory: 'packages/real' }
    assert.equal(await resolveRepo({ repository, homepage: 'https://github.com/acme/app/tree/main/packages/other' }), 'acme/app @ packages/real')
    assert.equal(await resolveRepo({ repository: { url: 'https://github.com/acme/app.git' }, homepage: 'https://github.com/acme/app/tree/HEAD/packages/web#readme' }), 'acme/app @ packages/web')
  })

  it('says nothing for a package at the repo root', async () => {
    // Absent, not empty: there is no directory to name at the root.
    assert.equal((await resolveOne(tracked('lodash/lodash'))).directory, undefined)
  })

  it('keeps `repository` and its directory over a tracker naming another repo', async () => {
    const body = {
      bugs: { url: 'https://github.com/acme/app/issues' },
      homepage: 'https://github.com/acme/app#readme',
      repository: { url: 'https://github.com/other/mono.git', directory: 'packages/thing' },
    }
    assert.equal(await resolveRepo(body), 'other/mono @ packages/thing')
  })

  it('drops a directory that belongs to a DIFFERENT repo', async () => {
    // `repository` names no GitHub repo, so the tracker decides, and the
    // directory is a path in the other one that says nothing about this.
    const body = {
      bugs: { url: 'https://github.com/acme/app/issues' },
      repository: { url: 'https://gitlab.com/other/mono.git', directory: 'packages/thing' },
    }
    assert.equal(await resolveRepo(body), 'acme/app')
  })

  it('drops a homepage path that points into a different repo', async () => {
    const body = { bugs: { url: 'https://github.com/acme/app/issues' }, homepage: 'https://github.com/other/mono/tree/main/packages/thing' }
    assert.equal(await resolveRepo(body), 'acme/app')
  })

  it('refuses a traversal in the directory', async () => {
    // It would be spliced into a github.com URL as-is.
    const body = { repository: { url: 'https://github.com/acme/app.git', directory: '../../etc' } }
    assert.equal(await resolveRepo(body), 'acme/app')
  })

  it('normalizes the spelling npm accepts', async () => {
    const at = async (directory) => await resolveRepo({ repository: { url: 'https://github.com/acme/app.git', directory } })
    assert.equal(await at('./packages/web/'), 'acme/app @ packages/web')
    assert.equal(await at('/packages/web'), 'acme/app @ packages/web')
    assert.equal(await at(''), 'acme/app')
    assert.equal(await at(42), 'acme/app')
  })
})

describe('getGitHub', () => {
  it('reads the repo off the issue tracker', async () => {
    assert.deepEqual(await resolveOne(tracked('lodash/lodash')), { github: 'lodash/lodash', url: 'https://github.com/lodash/lodash' })
  })

  it('takes `repository` over a stale or misspelt tracker', async () => {
    // has-symbols' tracker and homepage still name its old owner.
    const moved = {
      repository: { url: 'git://github.com/inspect-js/has-symbols.git', type: 'git' },
      bugs: { url: 'https://github.com/ljharb/has-symbols/issues' },
      homepage: 'https://github.com/ljharb/has-symbols#readme',
    }
    assert.deepEqual(await resolveOne(moved), { github: 'inspect-js/has-symbols', url: 'https://github.com/inspect-js/has-symbols' })
    // @exodus/test's tracker names ExodusOSS/tests, which is not its repo.
    const typo = {
      repository: { url: 'git+https://github.com/ExodusOSS/test.git', type: 'git' },
      bugs: { url: 'https://github.com/ExodusOSS/tests/issues' },
      homepage: 'https://github.com/ExodusOSS/test',
    }
    assert.equal((await resolveOne(typo)).github, 'ExodusOSS/test')
  })

  it('upgrades an http tracker link', async () => {
    const body = { bugs: { url: 'http://github.com/lodash/lodash/issues' }, homepage: 'https://github.com/lodash/lodash#readme' }
    assert.equal((await resolveOne(body)).github, 'lodash/lodash')
  })

  it("reads npm's `owner/name` shorthand when the package's own site is the homepage", async () => {
    // srvx: docs at srvx.h3.dev, code at github.com/h3js/srvx. Before
    // the shorthand this package simply had no repo link.
    const body = { homepage: 'https://srvx.h3.dev', repository: { url: 'h3js/srvx', type: 'git' } }
    assert.deepEqual(await resolveOne(body), { github: 'h3js/srvx', url: 'https://github.com/h3js/srvx' })
  })

  it('takes the shorthand as a bare string, and with an explicit `github:`', async () => {
    assert.equal((await resolveOne({ repository: 'h3js/srvx' })).github, 'h3js/srvx')
    assert.equal((await resolveOne({ repository: { url: 'github:h3js/srvx' } })).github, 'h3js/srvx')
  })

  it('reads a canonical repository URL, in every spelling npm accepts', async () => {
    // The field read first, and all a package whose `bugs` npm never
    // filled in has.
    const url = async (value) => (await resolveOne({ repository: { url: value } })).github
    assert.equal(await url('git+https://github.com/acme/widget.git'), 'acme/widget')
    assert.equal(await url('https://github.com/acme/widget'), 'acme/widget')
    assert.equal(await url('https://github.com/acme/widget/'), 'acme/widget')
    assert.equal(await url('git://github.com/acme/widget.git'), 'acme/widget')
    assert.equal(await url('git+ssh://git@github.com/acme/widget.git'), 'acme/widget')
    assert.equal(await url('git@github.com:acme/widget.git'), 'acme/widget')
    assert.equal(await url('https://github.com/socketio/socket.io.git'), 'socketio/socket.io')
  })

  it('refuses a URL that only LOOKS like a GitHub one', async () => {
    // github.com has to be the host. Either of these passing would point
    // the package at a repo it never came from.
    await assert.rejects(resolveOne({ repository: 'https://evil.example/github.com/acme/widget' }))
    await assert.rejects(resolveOne({ repository: 'https://github.com.evil.example/acme/widget' }))
    await assert.rejects(resolveOne({ repository: 'https://gitlab.com/acme/widget.git' }))
  })

  it('refuses a URL that points INTO a repo rather than at one', async () => {
    await assert.rejects(resolveOne({ repository: 'https://github.com/acme/widget/tree/main/pkg' }))
    await assert.rejects(resolveOne({ repository: 'https://github.com/acme' }))
  })

  it('keeps dots in the REPO name — `socket.io` is a repo', async () => {
    assert.equal((await resolveOne({ repository: 'socketio/socket.io' })).github, 'socketio/socket.io')
  })

  it('refuses a value that names a host rather than an owner', async () => {
    // Dots in the first segment are the tell: this is a domain with a
    // path, not `owner/name`, and taking it would point the package at
    // a github.com URL that does not exist.
    await assert.rejects(resolveOne({ repository: { url: 'srvx.h3.dev/srvx' } }))
  })

  it("refuses another forge's shorthand", async () => {
    await assert.rejects(resolveOne({ repository: 'gitlab:owner/name' }))
    await assert.rejects(resolveOne({ repository: { url: 'bitbucket:owner/name' } }))
  })

  it('refuses a tracker that is not a GitHub /issues page', async () => {
    await assert.rejects(resolveOne({ bugs: { url: 'https://bugs.example.com/file' }, homepage: 'https://example.com' }))
    await assert.rejects(resolveOne({ bugs: { url: 'https://github.com/owner/name' }, homepage: 'https://example.com' }))
  })

  it('refuses a package that names no repo at all', async () => {
    await assert.rejects(resolveOne({ homepage: 'https://example.com' }))
  })
})

describe('the npm → GitHub repo cache', () => {
  it('reads back what it wrote', async () => {
    assert.equal(await writePackageRepoCache('lodash', 'lodash/lodash'), true)
    assert.deepEqual(await readPackageRepoCache('lodash'), { github: 'lodash/lodash' })
  })

  it('misses on a name it has never seen', async () => {
    assert.equal(await readPackageRepoCache('left-pad'), null)
  })

  it('keeps a scoped name in ONE file rather than a directory', async () => {
    // `@babel/core` unescaped would put `core.json` under an `@babel`
    // directory — a path built out of a name a caller handed in.
    await writePackageRepoCache('@babel/core', 'babel/babel')
    assert.deepEqual(await readdir(REPOS), ['@babel+core.json'])
    assert.deepEqual(await readPackageRepoCache('@babel/core'), { github: 'babel/babel' })
  })

  it('misses on an entry older than the TTL, and hits on one inside it', async () => {
    await mkdir(REPOS, { recursive: true })
    const entry = (age) => JSON.stringify({ at: Date.now() - age, name: 'lodash', github: 'lodash/lodash', directory: '' })
    await writeFile(join(REPOS, 'lodash.json'), entry(31 * DAY))
    assert.equal(await readPackageRepoCache('lodash'), null)
    await writeFile(join(REPOS, 'lodash.json'), entry(29 * DAY))
    assert.deepEqual(await readPackageRepoCache('lodash'), { github: 'lodash/lodash' })
  })

  it('misses on a half-written file, an unstamped entry, or a slug that is not a string', async () => {
    await mkdir(REPOS, { recursive: true })
    const write = (body) => writeFile(join(REPOS, 'lodash.json'), body)
    await write('{"at":1,"github":"lodash/lo')
    assert.equal(await readPackageRepoCache('lodash'), null)
    await write(JSON.stringify({ github: 'lodash/lodash' }))
    assert.equal(await readPackageRepoCache('lodash'), null)
    await write(JSON.stringify({ at: Date.now(), github: { repo: 'lodash/lodash' }, directory: '' }))
    assert.equal(await readPackageRepoCache('lodash'), null)
    await write(JSON.stringify({ at: Date.now(), github: '', directory: '' }))
    assert.equal(await readPackageRepoCache('lodash'), null)
  })
})

describe('resolvePackageRepos', () => {
  it('asks the registry once per package and serves the next run from disk', async () => {
    const calls = stubRegistry({ lodash: tracked('lodash/lodash'), '@babel/core': tracked('babel/babel') })
    const names = new Set(['lodash', '@babel/core'])
    const expected = { lodash: { github: 'lodash/lodash' }, '@babel/core': { github: 'babel/babel' } }
    // By name, not by insertion: the lookups race each other through
    // Promise.all, so which one lands in the map first is not the point.
    assert.deepEqual(Object.fromEntries(await resolvePackageRepos(names)), expected)
    assert.deepEqual(calls.toSorted(), ['@babel/core', 'lodash'])

    // Same question, a fresh process's worth of stubbing: the answers
    // come back without a single request.
    const again = stubRegistry({})
    assert.deepEqual(Object.fromEntries(await resolvePackageRepos(names)), expected)
    assert.deepEqual(again, [])
  })

  it('does NOT cache a failure — the next run asks again', async () => {
    // A 404, a rate limit and a package with no repo link all land here.
    // Filing any of them would cost a month of packages with no link.
    const failed = stubRegistry({})
    assert.deepEqual([...await resolvePackageRepos(new Set(['lodash']))], [])
    assert.deepEqual(failed, ['lodash'])
    assert.deepEqual(await readdir(REPOS).catch(() => []), [])

    const recovered = stubRegistry({ lodash: tracked('lodash/lodash') })
    assert.deepEqual([...await resolvePackageRepos(new Set(['lodash']))], [['lodash', { github: 'lodash/lodash' }]])
    assert.deepEqual(recovered, ['lodash'])
  })

  it('under cachedOnly, answers from disk alone and never reaches for fetch', async () => {
    await writePackageRepoCache('lodash', 'lodash/lodash')
    // Unset, so a lookup that tried to request anything would throw
    // rather than quietly hit the network.
    globalThis.fetch = undefined
    const repos = await resolvePackageRepos(new Set(['lodash', 'left-pad']), { cachedOnly: true })
    // The cached one is answered; the uncached one simply goes without a
    // link.
    assert.deepEqual([...repos], [['lodash', { github: 'lodash/lodash' }]])
  })

  it('carries the directory through the cache, and answers it as `directory`', async () => {
    const mono = { repository: { url: 'https://github.com/babel/babel.git', directory: 'packages/babel-core' } }
    const asked = stubRegistry({ '@babel/core': mono })
    const stamp = { github: 'babel/babel', directory: 'packages/babel-core' }
    assert.deepEqual([...await resolvePackageRepos(new Set(['@babel/core']))], [['@babel/core', stamp]])
    assert.deepEqual(asked, ['@babel/core'])

    // Off disk on the next run, directory and all — the whole point of
    // writing it: a cached monorepo package that came back without one
    // would link to the root of a repo of hundreds.
    globalThis.fetch = undefined
    assert.deepEqual([...await resolvePackageRepos(new Set(['@babel/core']))], [['@babel/core', stamp]])
  })

  it('treats an entry written before `directory` existed as a miss', async () => {
    // Read leniently, it would answer with the repo and no directory,
    // and a monorepo package would quietly link to the repo root for a
    // month rather than being looked up once.
    await mkdir(REPOS, { recursive: true })
    await writeFile(join(REPOS, 'lodash.json'), JSON.stringify({ at: Date.now(), name: 'lodash', github: 'lodash/lodash' }))
    assert.equal(await readPackageRepoCache('lodash'), null)
  })

  it('round-trips a root package as an empty directory, not a missing one', async () => {
    await writePackageRepoCache('lodash', 'lodash/lodash')
    assert.deepEqual(await readPackageRepoCache('lodash'), { github: 'lodash/lodash' })
    await writePackageRepoCache('@babel/core', 'babel/babel', 'packages/babel-core')
    assert.deepEqual(await readPackageRepoCache('@babel/core'), { github: 'babel/babel', directory: 'packages/babel-core' })
  })
})

describe('getGitHub — the sources it reads, and what it holds them to', () => {
  it('reads the tracker without a homepage beside it', async () => {
    assert.equal((await resolveOne({ bugs: { url: 'https://github.com/acme/app/issues' } })).github, 'acme/app')
  })

  it('falls back to a GitHub homepage when nothing else names the repo', async () => {
    assert.deepEqual(await resolveOne({ homepage: 'https://github.com/acme/app#readme' }), { github: 'acme/app', url: 'https://github.com/acme/app' })
    assert.equal(await resolveRepo({ homepage: 'https://github.com/acme/app/tree/main/packages/pkg' }), 'acme/app @ packages/pkg')
    assert.equal((await resolveOne({ homepage: 'https://github.com/acme/app.git/' })).github, 'acme/app')
    // Behind the other two, not ahead of them.
    assert.equal((await resolveOne({ ...tracked('acme/app'), homepage: 'https://github.com/other/docs' })).github, 'acme/app')
    for (const homepage of ['https://github.com/acme', 'https://github.com/acme/app/issues', 'https://github.com.evil.example/acme/app', 'https://evil.example/github.com/acme/app']) {
      await assert.rejects(resolveOne({ homepage }), /no GitHub repo/u, homepage)
    }
  })

  it('takes only what is `owner/name` by GitHub rules, whichever field says it', async () => {
    for (const repository of ['acme/..', 'acme/.', 'https://github.com/acme/..', '-acme/app', 'ac_me/app', `${'a'.repeat(40)}/app`]) {
      await assert.rejects(resolveOne({ repository }), /no GitHub repo/u, repository)
    }
    // A bad one falls through to the next source rather than winning.
    assert.equal((await resolveOne({ repository: 'acme/..', homepage: 'https://github.com/acme/app' })).github, 'acme/app')
  })

  it("takes the scoped names npm does, and the registry's answer only for the name asked", async () => {
    for (const name of ['@foo.bar/pkg', '@foo_bar/pkg', 'pkg.', 'a..b', '@scope/_pkg', '@scope/-pkg', '@_scope/pkg', 'A1']) {
      stubRegistry({ [name]: tracked('acme/app') })
      assert.equal((await getGitHub(name)).github, 'acme/app', name)
    }
    globalThis.fetch = () => Promise.resolve(Response.json({ name: 'other', ...tracked('acme/app') }))
    await assert.rejects(getGitHub('pkg'), /getGitHub: the registry answered for "other", not pkg/u)
  })
})

describe('the npm → GitHub repo cache, held to the same formats', () => {
  it('refuses to write what a lookup would never answer', async () => {
    await assert.rejects(writePackageRepoCache('lodash', 'lodash/..'), /github must be "owner\/name"/u)
    await assert.rejects(writePackageRepoCache('lodash', 'lodash'), /github must be "owner\/name"/u)
    await assert.rejects(writePackageRepoCache('lodash', 'lodash/lodash', '../etc'), /directory must be a path inside the repository/u)
    await assert.rejects(writePackageRepoCache('../lodash', 'lodash/lodash'), /name must be an npm package name/u)
    await assert.rejects(readPackageRepoCache(['lodash']), /name must be an npm package name/u)
    assert.deepEqual(await readdir(REPOS).catch(() => []), [])
  })

  it('misses on an entry for another name, or with a repo or directory a lookup would not give', async () => {
    await mkdir(REPOS, { recursive: true })
    const write = (entry) => writeFile(join(REPOS, 'lodash.json'), JSON.stringify({ at: Date.now(), name: 'lodash', github: 'lodash/lodash', directory: '', ...entry }))
    for (const entry of [{ name: 'other' }, { github: 'lodash/..' }, { github: 'https://evil.example/x' }, { directory: '../etc' }, { directory: null }, { at: Date.now() + 60_000 }, { at: String(Date.now()) }]) {
      await write(entry)
      assert.equal(await readPackageRepoCache('lodash'), null, JSON.stringify(entry))
    }
  })
})

describe('resolvePackageRepos, at the registry', () => {
  it('asks a few at a time, not all at once', async () => {
    let inFlight = 0
    let most = 0
    globalThis.fetch = async (url) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      inFlight--
      const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', '').replace(/\/latest$/u, ''))
      return Response.json({ name, ...tracked(`acme/${name}`) })
    }
    const names = Array.from({ length: 30 }, (_, i) => `pkg${i}`)
    const repos = await resolvePackageRepos(names)
    assert.equal(repos.size, 30)
    assert.deepEqual(repos.get('pkg7'), { github: 'acme/pkg7' })
    assert.equal(most, 8)
  })
})
