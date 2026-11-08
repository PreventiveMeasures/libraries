import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { show } from '../args.js'
import { addRepos, readRepos } from '../cache.js'
import { lookUpCrateRepos } from '../cargo/repos.js'
import { specPath } from '../cocoapods.js'
import { COCOAPODS_CDN, PACKAGIST_REPO, PYPI, RUBYGEMS, SOLDEER_API, buildUrl, encodeSegment, isNotFound, recover, request } from '../http.js'
import { getVersionDocument } from '../npm/versions.js'
import { getRepo } from '../package.js'
import { pool } from '../pool.js'
import { normalName } from '../pypi/version.js'
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

// A pod's :http source on GitHub: an archive of a tag, or a release's asset.
const ARCHIVE = /^(?<repo>https:\/\/github\.com\/[\w-]+\/[\w.-]+)\/(?:archive|releases\/download)\//u

// The repo the podspec of a pod's newest version asked names: its `source`
// by :git, else by :http on GitHub, else its `homepage`. Trunk's CDN
// redirects to jsDelivr, which is followed; a podspec it does not have, a
// pod of another spec repo or of an external source, names none.
async function fetchPodRepo(name, version) {
  const url = buildUrl(COCOAPODS_CDN, specPath(name, version).map(encodeSegment))
  const podspec = await request(url, { as: 'json', redirect: 'follow' }).catch(recover(isNotFound, null))
  if (podspec === null) return null
  assert.ok(podspec?.name === name && podspec.version === version, `advisories: trunk answered for ${show(podspec?.name)} ${show(podspec?.version)}, not ${name} ${version}`)
  const { git, http } = podspec.source ?? {}
  return githubRepoOfUrl(git) ?? githubRepoOfUrl(ARCHIVE.exec(typeof http === 'string' ? http : '')?.groups.repo) ?? githubRepoOfUrl(podspec.homepage) ?? null
}

// rubygems.org's API takes 10 requests a second from one address, whichever
// call asks.
const GEM_PACE_MS = 100
let nextGemAt = 0
async function pacedForGems() {
  const now = Date.now()
  const at = Math.max(now, nextGemAt)
  nextGemAt = at + GEM_PACE_MS
  if (at > now) await sleep(at - now)
}

// Rails' gems link a page in the repo's tree, not the repo itself.
const TREE_PAGE = /^(?<repo>(?i:https?:\/\/github\.com)\/[\w-]+\/[\w.-]+)\/(?:tree|blob)\//u
const repoOfLink = (url) => githubRepoOfUrl(url) ?? githubRepoOfUrl(TREE_PAGE.exec(typeof url === 'string' ? url : '')?.groups.repo)

// `source_code_uri` has the gemspec's metadata, or what the owners set on
// rubygems.org.
async function fetchGemRepo(name) {
  await pacedForGems()
  const answer = await request(buildUrl(RUBYGEMS, ['api', 'v1', 'gems', `${name}.json`]), { as: 'json' }).catch(recover(isNotFound, null))
  if (answer === null) return null
  assert.ok(answer?.name === name, `advisories: rubygems.org answered for ${show(answer?.name)}, not ${name}`)
  return [answer.source_code_uri, answer.homepage_uri].map(repoOfLink).find((repo) => repo !== undefined) ?? null
}

// PyPI's JSON for the newest version asked, not the project's, which lists
// every release's files (3 MB for boto3). Its links by their labels, as PyPI
// normalizes them for its page: a project's source's first, then its
// homepage's, `home_page` among them, then the rest. A version's `+` and
// `!` (`1.13.0+cpu`, `1!2.0`) are escaped, as a path segment takes them.
const LABELS = ['source', 'sourcecode', 'repository', 'code', 'github', 'homepage']
const rank = ([label]) => {
  const at = LABELS.indexOf(label.toLowerCase().replaceAll(/[^\da-z]/gu, ''))
  return at === -1 ? LABELS.length : at
}
async function fetchPypiRepo(name, version) {
  const answer = await request(buildUrl(PYPI, ['pypi', name, version, 'json'].map(encodeSegment)), { as: 'json' }).catch(recover(isNotFound, null))
  if (answer === null) return null
  const info = answer?.info
  assert.ok(typeof info?.name === 'string' && normalName(info.name) === normalName(name), `advisories: PyPI answered for ${show(info?.name)}, not ${name}`)
  const links = [...Object.entries(info.project_urls ?? {}), ['home_page', info.home_page]].toSorted((a, b) => rank(a) - rank(b))
  return links.map(([, url]) => repoOfLink(url)).find((repo) => repo !== undefined) ?? null
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
export const gemRepos = (names, { cache }) => cachedRepos('rubygems/repos', names, (missing) => fetchEach(missing, fetchGemRepo), cache)
export const pypiRepos = (names, { asked, cache }) => cachedRepos('pypi/repos', names, (missing) => fetchEach(missing, (name) => fetchPypiRepo(name, asked.get(name).at(-1))), cache)
export const podRepos = (names, { asked, cache }) => cachedRepos('cocoapods/repos', names, (missing) => fetchEach(missing, (name) => fetchPodRepo(name, asked.get(name).at(-1))), cache)
export const npmRepos = (names, { asked, cache }) => fetchEach(names, (name) => npmRepo(name, asked.get(name).at(-1), cache))
export const soldeerRepos = (names, { cache }) => cachedRepos('soldeer/repos', names, (missing) => fetchEach(missing, fetchSoldeerRepo), cache)
