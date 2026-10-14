// A call made in a process of its own, where the peers named do not resolve, or, `imported`, resolve for
// import() alone, as on a runtime that requires no ES module (Vercel's): what it answers, or `{ thrown }`.
import { execFileSync } from 'node:child_process'

export function without(peers, call, { imported = false } = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module'
    const peers = new Set(${JSON.stringify(peers)})
    registerHooks({ resolve: (specifier, context, next) => {
      if (peers.has(specifier) && (${!imported} || context.conditions.includes('require'))) throw new Error('gone')
      return next(specifier, context)
    } })
    const answer = await (async () => { ${call} })().catch((err) => ({ thrown: err.message }))
    console.log(JSON.stringify(answer))`], { encoding: 'utf8' }))
}
