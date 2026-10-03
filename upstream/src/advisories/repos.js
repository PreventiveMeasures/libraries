import assert from 'node:assert/strict'

import { show } from '../args.js'
import { addRepos, readRepos } from '../cache.js'
import { lookUpCrateRepos } from '../cargo/repos.js'
import { PACKAGIST_REPO, SOLDEER_API, buildUrl, isNotFound, recover, request } from '../http.js'
import { lookUpPackageRepo } from '../npm/repos.js'
import { pool } from '../pool.js'
import { githubRepoOfUrl } from '../remote.js'

const PACKAGES_AT_ONCE = 8

// Name → its GitHub repo, or null where the registry has no such package
// or it names no GitHub repo; any other failure throws. Only a repo found
// is cached, for a month.
async function cachedRepos(dir, names, fetchMissing) {
  const repos = await readRepos(dir, names)
  await addRepos(dir, repos, await fetchMissing(names.filter((name) => !repos.has(name))))
  return repos
}

async function fetchEach(names, fetch) {
  const found = await pool(names, PACKAGES_AT_ONCE, fetch)
  return new Map(names.map((name, i) => [name, found[i]]))
}

// The first version in Packagist's file is its latest, in full.
async function fetchComposerRepo(name) {
  const [vendor, pkg] = name.split('/')
  const answer = await request(buildUrl(PACKAGIST_REPO, ['p2', vendor, `${pkg}.json`]), { as: 'json' }).catch(recover(isNotFound, null))
  if (answer === null) return null
  const versions = Object.hasOwn(answer.packages ?? {}, name) ? answer.packages[name] : undefined
  assert.ok(Array.isArray(versions), `advisories: Packagist answered without ${name}`)
  return githubRepoOfUrl(versions[0]?.source?.url) ?? null
}

// Soldeer answers a project it does not have with an empty list.
async function fetchSoldeerRepo(name) {
  const answer = await request(buildUrl(SOLDEER_API, ['api', 'v1', 'project'], { project_name: name }), { as: 'json' })
  assert.ok(Array.isArray(answer?.data), `advisories: expected a list of projects from Soldeer for ${name}`)
  for (const project of answer.data) assert.ok(project?.name === name, `advisories: Soldeer answered for ${show(project?.name)}, not ${name}`)
  return githubRepoOfUrl(answer.data[0]?.github_url) ?? null
}

export const crateRepos = (names) => lookUpCrateRepos('advisories', names)
export const composerRepos = (names) => cachedRepos('composer/repos', names, (missing) => fetchEach(missing, fetchComposerRepo))
export const npmRepos = (names) => fetchEach(names, async (name) => (await lookUpPackageRepo(name))?.github ?? null)
export const soldeerRepos = (names) => cachedRepos('soldeer/repos', names, (missing) => fetchEach(missing, fetchSoldeerRepo))
