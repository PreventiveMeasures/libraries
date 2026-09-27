import { isRepo } from './args.js'

// `owner/name` out of a GitHub remote URL, in the spellings git and npm
// write one: `git+https://github.com/acme/widget.git`, `git://github.com/…`,
// a plain `https://github.com/…`, `git+ssh://git@github.com/…`, and the
// scp-like `git@github.com:acme/widget.git`. A `.git` suffix and a
// trailing slash are noise rather than part of the name, and a `user@`
// or `user:token@` in front of the host is matched past, never kept.
//
// `github.com` has to be the HOST here, not a path segment or the start
// of a longer name: the scheme and the optional userinfo are matched
// explicitly, so neither `https://evil.example/github.com/a/b` nor
// `https://github.com.evil.example/a/b` can pass for a GitHub URL. And
// the answer has to be `owner/name` by GitHub's own rules, or there is
// none: another host, a path into a repo, a `..` for a name all answer
// undefined.
const gitUrlRegex = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]*@)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?\/?$/u
const scpRegex = /^(?:git\+ssh:\/\/)?git@github\.com:(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?$/u

export function githubRepoOfUrl(url) {
  if (typeof url !== 'string') return undefined
  const repo = (gitUrlRegex.exec(url) ?? scpRegex.exec(url))?.groups.repo
  return isRepo(repo) ? repo : undefined
}
