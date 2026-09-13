import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

import { ollamaAlternativeFor, ollamaAlternatives, ollamaModels, ollamaTagFor } from '../src/models.js'
import { forgetInstalledTags, installedTags, preferredTag, resolveOllamaTag } from '../src/ollama.js'

// A stand-in Ollama, listing whatever the case wants installed. A real socket
// rather than a stubbed fetch: the thing under test is that we speak to a
// server correctly, which a stub would assume rather than check.
function serving(names, { status = 200, body, seen } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (seen) seen.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
      return
    }
    if (req.url !== '/api/tags') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body ?? JSON.stringify({ models: names.map((name) => ({ name, model: name })) }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Each case gets its own origin AND a cleared cache, since the probe is
// remembered per origin for the life of the process.
async function withServer(names, options, fn) {
  const { server, origin } = await serving(names, options)
  const previous = process.env.OLLAMA_API_URL
  process.env.OLLAMA_API_URL = origin
  forgetInstalledTags()
  try {
    return await fn(origin)
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_API_URL
    else process.env.OLLAMA_API_URL = previous
    forgetInstalledTags()
    await new Promise((done) => { server.close(done) })
  }
}

describe('ollama alternatives — the same model under another tag', () => {
  const PLAIN = 'qwen3.6:35b-a3b-bf16'
  const TWIN = 'qwen3.6:35b-a3b-mtp-bf16'

  it('every alternative stands in for a tag the map actually uses', () => {
    // A key no row maps to could never fire, and would read as coverage the
    // provider does not have.
    const used = new Set(ollamaModels().map((id) => ollamaTagFor(id)))
    for (const [tag, alternatives] of ollamaAlternatives()) {
      assert.ok(used.has(tag), `${tag} is an alternative for a tag nothing maps to`)
      assert.ok(alternatives.length > 0, `${tag} has an empty alternative list`)
      for (const alternative of alternatives) {
        assert.ok(!used.has(alternative), `${alternative} is both an alternative and a mapped tag`)
        assert.equal(alternative.split(':')[0], tag.split(':')[0], `${alternative} is not in ${tag}'s library`)
        // Re-pointed across model sizes, so trusting it would eventually
        // serve something else entirely.
        assert.notEqual(alternative.split(':')[1], 'latest', alternative)
        // Substituting is a claim that the two answer the same, and only two
        // shapes earn it: the speculative-decoding twin, or a shorter name
        // for the same manifest.
        const twin = tag.replace(/-((?:bf16|q8_0|q4_K_M))$/u, '-mtp-$1')
        assert.ok(
          alternative === twin || tag.startsWith(alternative),
          `${alternative} is neither ${tag}'s twin nor a shorter name for it`,
        )
      }
    }
  })

  it('never offers gemma-4 26B\'s -mtp- build as a substitute', () => {
    // It has 8-bit attention where the plain build has 4-bit, so it answers
    // differently and holds an id — and a cache entry — of its own. The plain
    // build takes no substitute, and nothing anywhere substitutes to the mtp.
    assert.deepEqual(ollamaAlternativeFor('gemma4:26b-a4b-it-q4_K_M'), [])
    assert.ok(ollamaModels().includes('google/gemma-4-26b-a4b-it-mtp-q4_k_m'))
    for (const [tag, alternatives] of ollamaAlternatives()) {
      assert.ok(!alternatives.includes('gemma4:26b-a4b-it-mtp-q4_K_M'), tag)
    }
  })

  it('takes the alternative only when it is installed', () => {
    assert.equal(preferredTag(PLAIN, new Set([PLAIN, TWIN])), TWIN)
    assert.equal(preferredTag(PLAIN, new Set([PLAIN])), PLAIN)
    assert.equal(preferredTag(PLAIN, new Set()), PLAIN)
    // A tag with no alternative is returned whatever the server has.
    assert.equal(preferredTag('gemma4:31b-it-bf16', new Set(['gemma4:31b-it-bf16'])), 'gemma4:31b-it-bf16')
  })

  it('tries every alternative, not just the first', () => {
    // The list exists because a build can be installed under more than one
    // name: qwen's twin, and the short tag most people actually pull. Only
    // checking the head would leave whoever ran `ollama pull qwen3.6:27b`
    // being told the server has no such model.
    const CANON = 'qwen3.6:27b-q4_K_M'
    const [twin, short] = ollamaAlternativeFor(CANON)
    assert.ok(twin && short, `expected two alternatives, got ${ollamaAlternativeFor(CANON).join(', ')}`)
    assert.equal(preferredTag(CANON, new Set([short])), short)
    assert.equal(preferredTag(CANON, new Set([twin])), twin)
    // Order decides when both are there.
    assert.equal(preferredTag(CANON, new Set([twin, short])), twin)
  })

  it('reads what the server reports installed', async () => {
    await withServer([PLAIN, TWIN, 'llama3:latest'], {}, async () => {
      assert.deepEqual([...await installedTags()].sort(), [PLAIN, TWIN, 'llama3:latest'].sort())
    })
  })

  it('swaps in the twin when the server has it', async () => {
    await withServer([PLAIN, TWIN], {}, async () => {
      assert.equal(await resolveOllamaTag(PLAIN), TWIN)
    })
  })

  it('keeps the asked-for tag when the server has only that', async () => {
    await withServer([PLAIN], {}, async () => {
      assert.equal(await resolveOllamaTag(PLAIN), PLAIN)
    })
  })

  it('keeps the asked-for tag when the server answers badly', async () => {
    // A 500, and separately a 200 carrying something that is not the shape
    // expected. Neither is this function's problem to report.
    await withServer([], { status: 500 }, async () => {
      assert.equal(await resolveOllamaTag(PLAIN), PLAIN)
    })
    await withServer([], { body: '{"unexpected":true}' }, async () => {
      assert.equal(await resolveOllamaTag(PLAIN), PLAIN)
    })
  })

  it('keeps the asked-for tag when there is no server at all', async () => {
    // The turn that follows will fail with the server's own error, which says
    // far more than a probe timing out could.
    const previous = process.env.OLLAMA_API_URL
    // Port 1 is restricted, so this refuses rather than hanging.
    process.env.OLLAMA_API_URL = 'http://127.0.0.1:1'
    forgetInstalledTags()
    try {
      assert.equal(await resolveOllamaTag(PLAIN), PLAIN)
      assert.equal((await installedTags()).size, 0)
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_API_URL
      else process.env.OLLAMA_API_URL = previous
      forgetInstalledTags()
    }
  })

  it('asks once per origin, not once per turn', async () => {
    let asked = 0
    const server = createServer((req, res) => {
      asked++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: TWIN }] }))
    })
    await new Promise((ready) => { server.listen(0, '127.0.0.1', ready) })
    const previous = process.env.OLLAMA_API_URL
    process.env.OLLAMA_API_URL = `http://127.0.0.1:${server.address().port}`
    forgetInstalledTags()
    try {
      // Concurrent, because the cache holds the promise rather than the
      // answer — three turns starting together must still make one request.
      await Promise.all([resolveOllamaTag(PLAIN), resolveOllamaTag(PLAIN), resolveOllamaTag(PLAIN)])
      await resolveOllamaTag(PLAIN)
      assert.equal(asked, 1)
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_API_URL
      else process.env.OLLAMA_API_URL = previous
      forgetInstalledTags()
      await new Promise((done) => { server.close(done) })
    }
  })
})

describe('ollama adapter — the swap reaches the wire', () => {
  const MODEL = 'qwen/qwen3.6-35b-a3b-bf16'
  const PLAIN = 'qwen3.6:35b-a3b-bf16'
  const TWIN = 'qwen3.6:35b-a3b-mtp-bf16'
  let instance = 0

  // providers.js resolves its URL once, at module evaluation, so a case that
  // points it somewhere needs its own copy of the module.
  async function posting(installed) {
    const seen = []
    const { server, origin } = await serving(installed, { seen })
    const previous = process.env.OLLAMA_API_URL
    process.env.OLLAMA_API_URL = origin
    forgetInstalledTags()
    try {
      const mod = await import(`../src/providers.js?ollama-${instance++}`)
      mod.setProvider('ollama')
      const body = mod.buildRequestBody(MODEL, 100, 'sys', [{ role: 'user', content: 'hi' }])
      await mod.sendRequest(MODEL, body)
      return { sent: seen.at(-1), built: body }
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_API_URL
      else process.env.OLLAMA_API_URL = previous
      forgetInstalledTags()
      await new Promise((done) => { server.close(done) })
    }
  }

  it('posts the twin when the server has it', async () => {
    const { sent, built } = await posting([PLAIN, TWIN])
    assert.equal(sent.model, TWIN)
    // And the body the caller built is untouched — it is what the cache and
    // any retry see, and it names the model that was asked for.
    assert.equal(built.model, PLAIN)
  })

  it('posts what it built when the server has no twin', async () => {
    const { sent } = await posting([PLAIN])
    assert.equal(sent.model, PLAIN)
  })
})
