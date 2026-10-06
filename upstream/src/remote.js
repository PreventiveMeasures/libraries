import { isRepo } from './args.js'

// `user:token@` is skipped, never returned. It is held to the characters
// RFC 3986 allows there — a `#`, `?` or `\` before the `@` ends the
// authority early, so `https://evil.example#@github.com/a/b` goes to
// evil.example — and URL parsing has to agree the host is github.com.
const gitUrlRegex = /^(?i:(?:git\+)?(?:https?|git|ssh)):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?(?i:github\.com)(?::\d{1,5})?\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?\/?$/u
const scpRegex = /^(?i:git\+ssh:\/\/)?git@(?i:github\.com):(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?$/u

// A repo with every trailing `.git` dropped, so none ends in one: in a loop,
// as a regex would backtrack over a long run of them in a crafted URL.
export function withoutDotGit(repo) {
  while (repo?.endsWith('.git')) repo = repo.slice(0, -4)
  return repo
}

export function githubRepoOfUrl(url) {
  if (typeof url !== 'string') return undefined
  const onGitHub = URL.parse(url.replace(/^git\+/iu, ''))?.hostname.toLowerCase() === 'github.com'
  const repo = withoutDotGit(scpRegex.exec(url)?.groups.repo ?? (onGitHub ? gitUrlRegex.exec(url)?.groups.repo : undefined))
  return isRepo(repo) ? repo : undefined
}
