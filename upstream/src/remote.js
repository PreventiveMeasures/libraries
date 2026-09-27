import { isRepo } from './args.js'

// `user:token@` is skipped, never returned. It is held to the characters
// RFC 3986 allows there — a `#`, `?` or `\` before the `@` ends the
// authority early, so `https://evil.example#@github.com/a/b` goes to
// evil.example — and URL parsing has to agree the host is github.com.
const gitUrlRegex = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?\/?$/u
const scpRegex = /^(?:git\+ssh:\/\/)?git@github\.com:(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?$/u

const hostOf = (url) => {
  try {
    return new URL(url.replace(/^git\+/u, '')).hostname
  } catch {
    return null
  }
}

export function githubRepoOfUrl(url) {
  if (typeof url !== 'string') return undefined
  const scp = scpRegex.exec(url)?.groups.repo
  const repo = scp ?? (hostOf(url) === 'github.com' ? gitUrlRegex.exec(url)?.groups.repo : undefined)
  return isRepo(repo) ? repo : undefined
}
