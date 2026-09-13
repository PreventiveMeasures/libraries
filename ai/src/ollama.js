import { ollamaEquivalents } from './models.js'

// Asking the local server what it has, so a turn can be served by a better
// build of the model it asked for. providers.js is the adapter; this is the
// one thing the adapter cannot answer on its own.

// Read per call rather than at module load, so the cache below stays keyed to
// the origin actually asked rather than the one that happened to be set first.
export function ollamaOrigin() {
  return process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434'
}

// Short: a turn is waiting on this, and every answer it could give is
// optional. A server too slow to list its models is treated as having none.
const PROBE_TIMEOUT_MS = 2000

// One probe per origin, for the life of the process. A model pulled mid-run
// is not noticed, which costs a substitution rather than a turn.
const probes = new Map()

// Long-running callers that pull models between turns can ask again.
export function forgetInstalledTags() {
  probes.clear()
}

async function probe(origin) {
  try {
    const res = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return new Set()
    const json = await res.json()
    return new Set((json?.models ?? []).map((entry) => entry?.name).filter(Boolean))
  } catch {
    // Never fatal. The tag asked for is still a real tag, and the request
    // about to be made reports a down server better than a probe can.
    return new Set()
  }
}

export async function installedTags(origin = ollamaOrigin()) {
  if (!probes.has(origin)) probes.set(origin, probe(origin))
  return await probes.get(origin)
}

// The tag to actually post. Separated from the probe so the rule is testable
// without a server: an alternative is taken only when it is installed, and
// the tag asked for is always a valid answer.
export function preferredTag(tag, installed) {
  // The row's own tag is what gets posted when nothing better is there; the
  // rest are the same build under another name, taken when the server has one.
  const [canonical, ...others] = ollamaEquivalents(tag)
  return others.find((name) => installed.has(name)) ?? canonical
}

export async function resolveOllamaTag(tag) {
  return preferredTag(tag, await installedTags())
}
