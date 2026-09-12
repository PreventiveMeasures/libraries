import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// Drives the real loop against a local chat-completions server: a turn that
// calls a tool, then one that answers. Everything below the request — the
// adapter, the transport, the cache — is the real thing, which is the point:
// `partial` is a write chat() makes on its own now, and a version that
// quietly ignored the option would look exactly like a passing suite if the
// loop were stubbed out.
//
// The adapter's URL is read once, when providers.js is evaluated, so the
// imports here are dynamic and come after the server is up. The cache root
// is set through the layer once it is loaded.
const CACHE_DIR = join(tmpdir(), `ai-chat-loop-test-${process.pid}`)

const TOOL_CALL = {
  choices: [{
    message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'probe', arguments: '{"path":"/"}' } }] },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
}
const ANSWER = {
  choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 4, cost: 0 },
}

const requests = []
let queued = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(queued.shift() ?? ANSWER))
  })
})
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })

process.env.OPENROUTER_API_URL = `http://127.0.0.1:${server.address().port}`
process.env.OPENROUTER_API_KEY = 'test-key'
const { chat } = await import('../src/chat.js')
const { buildCacheOpts, getPartial, setCacheDir } = await import('../src/cache.js')
setCacheDir(CACHE_DIR)
const { setProvider } = await import('../src/providers.js')
setProvider('openrouter')

after(async () => {
  server.close()
  await rm(CACHE_DIR, { recursive: true, force: true })
})

const MODEL = 'test/chat-loop-1.0'
const opts = (type) => buildCacheOpts(type, { model: MODEL, systemPrompt: 'sys', useThink: false, useEffort: undefined })

function run(userContent, extra = {}) {
  queued = [TOOL_CALL]
  return chat({
    model: MODEL, maxTokens: 1024, systemPrompt: 'sys', userContent,
    tools: [{ name: 'probe', description: 'probe', input_schema: { type: 'object' } }],
    handleToolCall: (call) => `probed ${call.args.path}`,
    label: 'test', ...extra,
  })
}

describe('chat: the tool loop', () => {
  it('runs a turn per response until the model stops calling tools', async () => {
    const before = requests.length
    const result = await run('loop-A')
    assert.equal(result.text, 'done')
    assert.equal(result.error, undefined)
    assert.equal(result.history.length, 2)
    assert.equal(requests.length - before, 2)
    // The tool's answer is threaded into the second request, so the model
    // sees what it asked for.
    assert.equal(result.history[0].results[0], 'probed /')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('probed /'))
    // Both turns' tokens are counted, not just the last.
    assert.equal(result.usage.input, 30)
    assert.equal(result.usage.output, 6)
  })
})

describe('chat: the `partial` option', () => {
  it('writes the running history after every turn, under the caller\'s cache options', async () => {
    const cacheOpts = opts('_test-chat-partial')
    const result = await run('loop-B', { partial: cacheOpts })
    // Written, and written whole: a process killed after the tool turn
    // resumes at turn 2 instead of paying for turn 1 again.
    const saved = await getPartial('loop-B', cacheOpts)
    assert.equal(saved.length, 2)
    assert.deepEqual(saved.at(-1).toolCalls, result.history.at(-1).toolCalls)
    assert.deepEqual(saved[0].results, ['probed /'])
  })

  it('keys the partial on the whole user message, suffix included', async () => {
    // A request that splits its message into a cached prefix and a
    // per-request tail is still cached under the two joined, so the partial
    // has to land on the same key the final result will.
    const cacheOpts = opts('_test-chat-partial-split')
    await run('prefix-', { userContentSuffix: 'suffix', partial: cacheOpts })
    assert.equal(await getPartial('prefix-', cacheOpts), null)
    assert.equal((await getPartial('prefix-suffix', cacheOpts)).length, 2)
  })

  it('writes nothing when the caller passes no cache options', async () => {
    const cacheOpts = opts('_test-chat-no-partial')
    await run('loop-C')
    assert.equal(await getPartial('loop-C', cacheOpts), null)
  })
})
