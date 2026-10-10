import assert from 'node:assert/strict'

import { show } from '../args.js'
import { addRepos, readRepos } from '../cache.js'
import { lookUpCrateRepos } from '../cargo/repos.js'
import { PACKAGIST_REPO, SOLDEER_API, buildUrl, isNotFound, recover, request } from '../http.js'
import { getVersionDocument } from '../npm/versions.js'
import { getRepo } from '../package.js'
import { pool } from '../pool.js'
import { githubRepoOfUrl } from '../remote.js'

const PACKAGES_AT_ONCE = 8

// Name -> its GitHub repo, or null where the registry has no such package
// or it names no GitHub repo; any other failure throws. Only a repo found
// is cached, for a month, in the cache set or `cache` (readRecord).
async function cachedRepos(dir, names, fetchMissing, cache) {
  const repos = await readRepos(dir, names, cache)
  await addRepos(dir, repos, await fetchMissing(names.filter((name) => !repos.has(name))), cache)
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

// The repo the newest version asked of each package names, from that
// version's document, kept for good (getVersionDocument): null where the
// registry does not have that version, or it names no GitHub repo.
async function npmRepo(name, version, cache) {
  const json = await getVersionDocument('advisories', name, version, cache)
  return (json && getRepo(json).github) ?? null
}

// Each takes the names to look up, the versions `asked` of each, and the
// call's `cache`.
export const crateRepos = (names, { cache }) => lookUpCrateRepos('advisories', names, { cache })
export const composerRepos = (names, { cache }) => cachedRepos('composer/repos', names, (missing) => fetchEach(missing, fetchComposerRepo), cache)
export const npmRepos = (names, { asked, cache }) => fetchEach(names, (name) => npmRepo(name, asked.get(name).at(-1), cache))
export const soldeerRepos = (names, { cache }) => cachedRepos('soldeer/repos', names, (missing) => fetchEach(missing, fetchSoldeerRepo), cache)
