import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// Drives the real loop against a local chat-completions server: a turn that
// calls a tool, then one that answers. Everything below the request — the
// adapter, the transport, the cache — is the real thing, which is the point:
// `partial` is a read and a write ask() makes on its own now, and a version
// that quietly ignored the option would look exactly like a passing suite if
// the loop were stubbed out.
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

const URL_BASE = `http://127.0.0.1:${server.address().port}`
process.env.OPENROUTER_API_URL = URL_BASE
process.env.OPENROUTER_API_KEY = 'test-key'
const { ask } = await import('../src/chat.js')
const { buildCacheOpts, getPartial, setCacheDir, setPartial } = await import('../src/cache.js')
const { getProvider, providerStamp, setProvider } = await import('../src/providers.js')

after(async () => {
  server.close()
  await rm(CACHE_DIR, { recursive: true, force: true })
})

// The cache root and the selected provider are both process-wide, and
// `--test-isolation=none` puts every test file in one process: all of their
// top levels run before any suite does, so setting either at module scope
// would leave whichever file was imported LAST holding it. Each suite
// claims both for itself instead.
//
// The assertion is the important half. providers.js reads OPENROUTER_API_URL
// once, when it is evaluated — the dynamic imports above are why that
// happens after the server has a port — and a file that pulled providers.js
// in EARLIER would leave this suite pointed at the real openrouter.ai with
// nothing but a network error to say so. Checked rather than assumed,
// because the failure mode is a test posting to a live API.
const suite = (name, body) => describe(name, () => {
  before(() => {
    setCacheDir(CACHE_DIR)
    setProvider('openrouter')
    assert.ok(
      getProvider().url.startsWith(URL_BASE),
      `adapter points at ${getProvider().url}, not this suite's server — providers.js was evaluated before it was listening`,
    )
  })
  body()
})

const MODEL = 'test/chat-loop-1.0'
const opts = (type) => buildCacheOpts(type, { model: MODEL, systemPrompt: 'sys', useThink: false, useEffort: undefined })

// `responses` is what the server hands back, in order, before it falls back
// to ANSWER: a run that resumes a completed tool turn wants the answer
// first, not another tool call.
function run(userContent, extra = {}, responses = [TOOL_CALL]) {
  queued = responses
  return ask({
    model: MODEL, maxTokens: 1024, systemPrompt: 'sys', userContent,
    tools: [{ name: 'probe', description: 'probe', input_schema: { type: 'object' } }],
    handleToolCall: (call) => `probed ${call.args.path}`,
    label: 'test', ...extra,
  })
}

suite('chat: the tool loop', () => {
  it('runs a turn per response until the model stops calling tools', async () => {
    const sentBefore = requests.length
    const result = await run('loop-A')
    assert.equal(result.text, 'done')
    assert.equal(result.error, undefined)
    assert.equal(result.history.length, 2)
    assert.equal(requests.length - sentBefore, 2)
    // The tool's answer is threaded into the second request, so the model
    // sees what it asked for.
    assert.equal(result.history[0].results[0], 'probed /')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('probed /'))
    // Both turns' tokens are counted, not just the last.
    assert.equal(result.usage.input, 30)
    assert.equal(result.usage.output, 6)
  })
})

suite('chat: the `partial` option', () => {
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

  it('keys the partial on the whole user message, every block joined', async () => {
    // A request that splits its message into a cached prefix and a
    // per-request tail is still cached under the blocks joined, so the
    // partial has to land on the same key the final result will.
    const cacheOpts = opts('_test-chat-partial-split')
    const sentBefore = requests.length
    await run(['pre', 'fix-', 'suffix'], { partial: cacheOpts })
    assert.equal(await getPartial('pre', cacheOpts), null)
    assert.equal(await getPartial('prefix-', cacheOpts), null)
    assert.equal((await getPartial('prefix-suffix', cacheOpts)).length, 2)
    // And the model was asked the joined message: this route reads no cache
    // marker, so the blocks concatenate rather than going out split. The key
    // above and the content here are the same string either way, which is the
    // property that lets a split request resume under an unsplit one's entry.
    assert.equal(requests[sentBefore].messages.at(-1).content, 'prefix-suffix')
  })

  it('writes nothing when the caller passes no cache options', async () => {
    const cacheOpts = opts('_test-chat-no-partial')
    await run('loop-C')
    assert.equal(await getPartial('loop-C', cacheOpts), null)
  })
})

// A partial as an interrupted run leaves one: turns already paid for, each
// stamped with the wire format that wrote it. Built here rather than by
// running a conversation and killing it, so a case can say exactly what
// state it is picking up from.
const toolTurn = (content) => ({
  request: { model: MODEL, messages: [{ role: 'user', content }] },
  response: TOOL_CALL,
  messages: [{ role: 'user', content }],
  toolCalls: [{ id: 'call-1', name: 'probe', args: { path: '/' } }],
  results: ['probed /'],
  provider: providerStamp(MODEL),
})
const answerTurn = (content) => ({
  request: null,
  response: ANSWER,
  messages: [{ role: 'user', content }],
  toolCalls: [],
  results: [],
  provider: providerStamp(MODEL),
})

suite('chat: resuming a partial', () => {
  it('picks up at the turn an interrupted run stopped on', async () => {
    const cacheOpts = opts('_test-chat-resume')
    await setPartial('resume-A', [toolTurn('resume-A')], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-A', { partial: cacheOpts }, [])
    // One request, not two: the tool turn was paid for by the run that died.
    assert.equal(requests.length - sentBefore, 1)
    assert.equal(result.text, 'done')
    assert.equal(result.history.length, 2)
    // Its result is threaded into the turn that did go out, so the model
    // sees the answer to the call it made last time.
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('probed /'))
    // And the resumed turn's tokens are not re-counted — this run pays for
    // what it sent, which is what the caller's cost line reports.
    assert.equal(result.usage.input, 20)
  })

  it('returns the answer of a run killed after its last turn, without asking again', async () => {
    const cacheOpts = opts('_test-chat-resume-finished')
    await setPartial('resume-B', [toolTurn('resume-B'), answerTurn('resume-B')], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-B', { partial: cacheOpts }, [])
    assert.equal(requests.length, sentBefore)
    assert.equal(result.text, 'done')
    assert.equal(result.usage.input, 0)
  })

  it('resumes a partial once, so a retry is not handed the answer it rejected', async () => {
    // The run that resumes goes on to overwrite the partial turn by turn, so
    // a caller asking again — a format-retry over the same content — would
    // otherwise short-circuit onto the answer it just threw away, forever.
    const cacheOpts = opts('_test-chat-resume-twice')
    await setPartial('resume-C', [toolTurn('resume-C'), answerTurn('resume-C')], cacheOpts)
    await run('resume-C', { partial: cacheOpts }, [])
    const sentBefore = requests.length
    const retry = await run('resume-C', { partial: cacheOpts })
    assert.equal(requests.length - sentBefore, 2)
    assert.equal(retry.history.length, 2)
  })

  it('drops a partial another provider wrote instead of replaying its shapes', async () => {
    const cacheOpts = opts('_test-chat-resume-alien')
    await setPartial('resume-D', [{ ...toolTurn('resume-D'), provider: 'anthropic' }], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-D', { partial: cacheOpts })
    // A whole conversation from the top, and nothing of the alien one left
    // on disk for the next process to try again.
    assert.equal(requests.length - sentBefore, 2)
    assert.equal(result.history.length, 2)
    const saved = await getPartial('resume-D', cacheOpts)
    assert.deepEqual(saved.map((e) => e.provider), [providerStamp(MODEL), providerStamp(MODEL)])
  })

  it('clears the one it rejected, rather than leaving it for the next process', async () => {
    // maxToolTurns: 0 so this run writes no partial of its own, and what is
    // left on disk is whatever the rejection did with the alien one. The run
    // above overwrites it either way, which is why that case cannot say.
    const cacheOpts = opts('_test-chat-resume-alien-cleared')
    await setPartial('resume-E', [{ ...toolTurn('resume-E'), provider: 'anthropic' }], cacheOpts)
    await run('resume-E', { partial: cacheOpts, maxToolTurns: 0 })
    assert.equal(await getPartial('resume-E', cacheOpts), null)
  })
})

suite('chat: the `onStart` option', () => {
  it('hands over the resumed turns before the first request goes out', async () => {
    const cacheOpts = opts('_test-chat-onstart')
    await setPartial('start-A', [toolTurn('start-A')], cacheOpts)
    const sentBefore = requests.length
    let atStart = null
    await run('start-A', {
      partial: cacheOpts,
      // Slow on purpose: a caller that spins a tool's state back up takes
      // its time, and ask() has to wait rather than race the first turn
      // against it. Unawaited, the request below would already have landed.
      onStart: async (history) => {
        await new Promise((resolve) => { setTimeout(resolve, 25) })
        atStart = { results: history.map((e) => e.results), sent: requests.length - sentBefore }
      },
    }, [])
    assert.deepEqual(atStart, { results: [['probed /']], sent: 0 })
  })

  it('is called with no turns on a fresh run', async () => {
    const seen = []
    await run('start-B', { onStart: (history) => seen.push(history) })
    assert.deepEqual(seen, [[]])
  })
})
