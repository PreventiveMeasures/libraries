import { isRepo } from './args.js'

// `user:token@` is skipped, never returned. It is held to the characters
// RFC 3986 allows there — a `#`, `?` or `\` before the `@` ends the
// authority early, so `https://evil.example#@github.com/a/b` goes to
// evil.example — and URL parsing has to agree the host is github.com.
const gitUrlRegex = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?\/?$/u
const scpRegex = /^(?:git\+ssh:\/\/)?git@github\.com:(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?$/u

export function githubRepoOfUrl(url) {
  if (typeof url !== 'string') return undefined
  const onGitHub = URL.parse(url.replace(/^git\+/u, ''))?.hostname === 'github.com'
  const repo = scpRegex.exec(url)?.groups.repo ?? (onGitHub ? gitUrlRegex.exec(url)?.groups.repo : undefined)
  return isRepo(repo) ? repo : undefined
}
