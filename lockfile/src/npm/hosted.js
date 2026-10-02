// A repository on a git host npm knows by name, read as hosted-git-info 9
// reads it: GitHub, GitLab, Bitbucket, a gist or sourcehut, by a shortcut
// (`github:user/repo`, or `user/repo` alone for GitHub) or by a URL on the
// host's domain. npm holds two of these to be one repository where the ssh
// URLs it would clone them from are one.

const trimGit = (project) => (project?.endsWith('.git') ? project.slice(0, -4) : project)

// The user and project, where there are both, `.git` off the project.
function repo(user, project, committish) {
  const trimmed = trimGit(project)
  return user && trimmed ? { user, project: trimmed, committish } : undefined
}

// `/user/project`, but where the path goes on to `skip`.
const userProject = (skip) => (url) => {
  const [, user, project, aux] = url.pathname.split('/', 4)
  return aux === skip ? undefined : repo(user, project, url.hash.slice(1))
}

const HOSTS = {
  __proto__: null,
  github: {
    protocols: ['git:', 'http:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'],
    domain: 'github.com',
    extract: (url) => {
      const [, user, project, type, committish] = url.pathname.split('/', 5)
      if (type && type !== 'tree') return undefined
      return repo(user, project, type ? committish : url.hash.slice(1))
    },
  },
  bitbucket: { protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'], domain: 'bitbucket.org', extract: userProject('get') },
  gitlab: {
    protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'],
    domain: 'gitlab.com',
    extract: (url) => {
      const path = url.pathname.slice(1)
      if (path.includes('/-/') || path.includes('/archive.tar.gz')) return undefined
      const segments = path.split('/')
      const project = segments.pop()
      return repo(segments.join('/'), project, url.hash.slice(1))
    },
  },
  gist: {
    protocols: ['git:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'],
    domain: 'gist.github.com',
    extract: (url) => {
      const [, user, project, aux] = url.pathname.split('/', 4)
      if (aux === 'raw' || !(user || project)) return undefined
      // A gist by its id alone is of no user.
      return { user: project ? user : null, project: trimGit(project || user), committish: url.hash.slice(1) }
    },
  },
  sourcehut: { protocols: ['git+ssh:', 'https:'], domain: 'git.sr.ht', extract: userProject('archive') },
}

const BY_DOMAIN = new Map(Object.entries(HOSTS).map(([name, host]) => [host.domain, name]))
const BY_SHORTCUT = new Map(Object.keys(HOSTS).map((name) => [`${name}:`, name]))
const PROTOCOLS = new Set(['git+ssh:', 'ssh:', 'git+https:', 'git:', 'http:', 'https:', 'git+http:', ...BY_SHORTCUT.keys()])

// isGitHubShorthand: `user/repo`, with no protocol, space, `@` or second
// `/` before any `#`.
function isShorthand(arg) {
  const hash = arg.indexOf('#')
  const before = (index) => index === -1 || (hash > -1 && index > hash)
  const slash = arg.indexOf('/')
  return (before(arg.search(/\s/u)) && slash > 0 && (hash > -1 ? arg[hash - 1] !== '/' : !arg.endsWith('/')) && !arg.startsWith('.')
    && before(arg.indexOf('@')) && before(arg.indexOf(':')) && before(arg.indexOf('/', slash + 1)))
}

const lastBefore = (text, char, stop) => {
  const end = text.indexOf(stop)
  return text.lastIndexOf(char, end > -1 ? end : Infinity)
}

// parse-url.js: `host:path` made `host://path`, and an scp-style
// `user@host:path` made a URL, before a URL is read.
function correctProtocol(arg) {
  const colon = arg.indexOf(':')
  if (PROTOCOLS.has(arg.slice(0, colon + 1)) || arg.slice(colon, colon + 3) === '://') return arg
  const at = arg.indexOf('@')
  if (at > -1) return at > colon ? `git+ssh://${arg}` : arg
  return `${arg.slice(0, colon + 1)}//${arg.slice(colon + 1)}`
}

function correctUrl(url) {
  let corrected = url
  const colon = lastBefore(corrected, ':', '#')
  if (colon > lastBefore(corrected, '@', '#')) corrected = `${corrected.slice(0, colon)}/${corrected.slice(colon + 1)}`
  if (lastBefore(corrected, ':', '#') === -1 && !corrected.includes('//')) corrected = `git+ssh://${corrected}`
  return corrected
}

const decode = (value) => (value ? decodeURIComponent(value) : value)

function fromShortcut(parsed) {
  let path = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname
  const at = path.indexOf('@')
  if (at > -1) path = path.slice(at + 1)
  const slash = path.lastIndexOf('/')
  const project = trimGit(decode(path.slice(slash + 1)))
  return { user: slash > -1 ? decode(path.slice(0, slash)) || null : null, project, committish: decode(parsed.hash.slice(1)) || null }
}

// The repository a spec or a resolved URL names, or undefined where it is on
// no host npm knows: the host's name, the user and project, and the
// committish after `#`, or null.
export function fromHostedUrl(arg) {
  if (!arg) return undefined
  const url = correctProtocol(isShorthand(arg) ? `github:${arg}` : arg)
  const parsed = URL.parse(url) ?? URL.parse(correctUrl(url))
  if (parsed === null) return undefined
  const shortcut = BY_SHORTCUT.get(parsed.protocol)
  const type = shortcut ?? BY_DOMAIN.get(parsed.hostname.replace(/^www\./u, ''))
  if (type === undefined) return undefined
  try {
    if (shortcut !== undefined) return { type, ...fromShortcut(parsed) }
    if (!HOSTS[type].protocols.includes(parsed.protocol)) return undefined
    const segments = HOSTS[type].extract(parsed)
    if (segments === undefined) return undefined
    return { type, user: decode(segments.user), project: decode(segments.project), committish: decode(segments.committish) || null }
  } catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
}

// The ssh URL npm clones a repository from, which it compares two by: the
// committish only where `committish` says.
export function sshOf({ type, user, project, committish }, withCommittish) {
  const hash = withCommittish && committish ? `#${committish}` : ''
  return type === 'gist' ? `git@${HOSTS[type].domain}:${project}.git${hash}` : `git@${HOSTS[type].domain}:${user}/${project}.git${hash}`
}
