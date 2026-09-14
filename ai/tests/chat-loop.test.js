import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const { buildCacheOpts, cacheDir, cacheKey, getPartial, modelSubdir, setCacheDir, setPartial } = await import('../src/cache.js')
const { normalizeCache, normalizeCacheFile } = await import('../src/cache-normalize.js')
const { calculateCost } = await import('../src/models.js')
const { appendToolResults, getProvider, providerStamp, setProvider } = await import('../src/providers.js')

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
    assert.equal(result.history[0].toolResults[0], 'probed /')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('probed /'))
    // Both turns' tokens are counted, not just the last.
    assert.equal(result.usage.input, 30)
    assert.equal(result.usage.output, 6)
  })
})

suite('chat: a tool that answers with plain data', () => {
  const LISTING = { files: ['a.js', 'b.js'], truncated: false }

  // The same conversation run() drives, with the handler answering something other than a string.
  const runWith = (userContent, result, extra = {}) => run(userContent, { handleToolCall: () => result, ...extra })

  it('sends it as JSON and keeps it as structure', async () => {
    const cacheOpts = opts('_test-chat-plain-data')
    const result = await runWith('plain-A', LISTING, { partial: cacheOpts })
    // The wire takes a string, and this is the one it takes.
    const sent = requests.at(-1).messages.find((m) => m.role === 'tool')
    assert.equal(sent.content, JSON.stringify(LISTING))
    // The cache takes the object — escaped inside a string it would be far worse to read, and the
    // replay stringifies it back to the same bytes.
    assert.deepEqual(result.history[0].toolResults, [LISTING])
    assert.deepEqual((await getPartial('plain-A', cacheOpts))[0].toolResults, [LISTING])
  })

  it('sends an array the same way, and a string untouched', async () => {
    await runWith('plain-B', ['one', 'two'])
    assert.equal(requests.at(-1).messages.find((m) => m.role === 'tool').content, '["one","two"]')
    await runWith('plain-C', 'just a string')
    assert.equal(requests.at(-1).messages.find((m) => m.role === 'tool').content, 'just a string')
  })

  it('refuses anything else, rather than sending a body no format has a field for', async () => {
    // A Map or a class instance has a shape JSON.stringify silently loses, so converting it is not
    // this layer's call to make — and passing it through buys an upstream error about a body the
    // provider could not read, or on chrome an `[object Object]` handed to the model as an answer.
    const rejected = [new Map([['a', 1]]), new Date(0), 42, undefined, null, Object.create(null)]
    for (const [i, bad] of rejected.entries()) {
      await assert.rejects(() => runWith(`plain-D-${i}`, bad), /must be a string or plain data/u)
    }
  })

  it('refuses one nested inside plain data too, which is the same loss one level down', async () => {
    // `{ rows: new Map() }` is the natural way to answer with a row set, and the top-level check
    // waves it through: JSON.stringify renders it `{"rows":{}}` and the model is handed an empty
    // object as the tool's answer, with nothing anywhere saying so.
    for (const [i, bad] of [{ rows: new Map() }, { ts: new Date(0) }, { a: undefined }, [[new Set()]]].entries()) {
      await assert.rejects(() => runWith(`plain-N-${i}`, bad), /which JSON does not carry whole/u)
    }
  })

  it('writes nothing when it refuses one, rather than leaving it for the next run to read', async () => {
    // The check runs where the result is produced, not at the wire — two statements and a disk
    // write later. Persisted first, a refused answer passes the resume gate on shape and throws
    // again out of the replay, in this process and every one after it.
    const cacheOpts = opts('_test-chat-plain-refused')
    await assert.rejects(() => runWith('plain-R', 42, { partial: cacheOpts }), /must be a string or plain data/u)
    assert.equal(await getPartial('plain-R', cacheOpts), null)
  })

  it('replays a stored object as the same JSON the live turn sent', async () => {
    const cacheOpts = opts('_test-chat-plain-data-resume')
    const turn = { ...toolTurn('plain-E'), toolResults: [LISTING] }
    await setPartial('plain-E', [turn], cacheOpts)
    await run('plain-E', { partial: cacheOpts }, [])
    assert.equal(requests.at(-1).messages.find((m) => m.role === 'tool').content, JSON.stringify(LISTING))
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
    assert.deepEqual(saved[0].toolResults, ['probed /'])
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
const toolTurn = (content, path = '/') => ({
  request: { model: MODEL, messages: [{ role: 'user', content }] },
  response: TOOL_CALL,
  messages: [{ role: 'user', content }],
  toolCalls: [{ id: 'call-1', name: 'probe', args: { path } }],
  toolResults: [`probed ${path}`],
  provider: providerStamp(MODEL),
})
const answerTurn = (content) => ({
  request: null,
  response: ANSWER,
  messages: [{ role: 'user', content }],
  toolCalls: [],
  toolResults: [],
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

  it('replays every stored turn, though only the first one\'s snapshot was kept', async () => {
    // setPartial keeps entry 0's `messages` and nulls the rest, so what goes back to the model is
    // rebuilt by walking the turns. Two rounds, because one would be rebuilt correctly by a
    // version that replayed only the last entry.
    const cacheOpts = opts('_test-chat-resume-multi')
    await setPartial('resume-G', [toolTurn('resume-G', '/0'), toolTurn('resume-G', '/1')], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-G', { partial: cacheOpts }, [])
    assert.equal(requests.length - sentBefore, 1)
    assert.equal(result.history.length, 3)
    // Seed, then an assistant turn and its tool result per round, in the order they happened.
    const sent = requests.at(-1).messages
    assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool'])
    assert.deepEqual(sent.filter((m) => m.role === 'tool').map((m) => m.content), ['probed /0', 'probed /1'])
  })

  it('starts fresh from a partial the adapters cannot replay, instead of failing on it forever', async () => {
    // isResumableHistory judges shape, not every value a turn holds, so a partial from a build
    // that let a bad result through still gets this far. Throwing here would throw identically in
    // every later process, so it is treated like any other unusable partial.
    const cacheOpts = opts('_test-chat-unreplayable')
    await setPartial('resume-X', [{ ...toolTurn('resume-X'), toolResults: [42] }], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-X', { partial: cacheOpts })
    assert.equal(requests.length - sentBefore, 2) // the whole conversation, from the top
    assert.equal(result.history.length, 2)
    assert.deepEqual(result.history[0].toolResults, ['probed /'])
  })

  it('reads a partial that still calls the field `results`', async () => {
    // The name changed once it had a `toolCalls` sibling to be confused with. A run interrupted
    // before that landed is still on someone's disk, and is still worth picking up.
    const cacheOpts = opts('_test-chat-resume-legacy')
    const { toolResults, ...legacy } = toolTurn('resume-H')
    await setPartial('resume-H', [{ ...legacy, results: toolResults }], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-H', { partial: cacheOpts }, [])
    assert.equal(requests.length - sentBefore, 1)
    assert.equal(result.history.length, 2)
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('probed /'))
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

  it('does not look at all without the option, whatever is on disk', async () => {
    // `partial` is the whole opt-in. Reading a key the caller never named would hand this run
    // turns from some other run over the same content, and charge nothing to say so.
    const cacheOpts = opts('_test-chat-no-partial-read')
    await setPartial('resume-F', [toolTurn('resume-F')], cacheOpts)
    const sentBefore = requests.length
    const result = await run('resume-F')
    assert.equal(requests.length - sentBefore, 2)
    assert.equal(result.history.length, 2)
  })

  it('takes the one it rejected out of service, not leaving it for the next process', async () => {
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
        atStart = { results: history.map((e) => e.toolResults), sent: requests.length - sentBefore }
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

// Where an entry's history lives, built from the layer's own helpers so a change to the layout
// cannot leave these looking in the wrong place.
const entryPath = async (userContent, o) => join(cacheDir(), await modelSubdir(o.type, o.model, o.systemPrompt), `${await cacheKey(o.systemPrompt, userContent, o)}.json`)

// A history as it was written before the snapshots came out: the same turns toolTurn builds, each
// carrying its own copy of every message ahead of it. Grown through appendToolResults, so the
// snapshots are the real thing and not a guess at what the loop records. `field` names where the
// results go, since a file old enough to hold snapshots is old enough to predate the rename.
function fat(content, paths, field = 'toolResults') {
  const messages = [{ role: 'user', content }]
  return paths.map((path) => {
    const { toolResults, ...turn } = toolTurn(content, path)
    const entry = { ...turn, messages: [...messages], [field]: toolResults }
    appendToolResults(messages, entry.response, entry.toolCalls, toolResults)
    return entry
  })
}

async function writeRaw(userContent, cacheOpts, history) {
  const path = await entryPath(userContent, cacheOpts)
  await mkdir(dirname(path), { recursive: true })
  const raw = JSON.stringify(history, undefined, 2)
  await writeFile(path, raw)
  return { path, raw }
}

suite('normalizeCacheFile', () => {
  it('drops the snapshots and resumes to exactly the messages they recorded', async () => {
    const cacheOpts = opts('_test-normalize')
    const history = fat('norm-A', ['/0', '/1', '/2', '/3', '/4', '/5'])
    const { path, raw } = await writeRaw('norm-A', cacheOpts, history)

    const done = await normalizeCacheFile(path)
    assert.equal(done.status, 'normalized')
    assert.equal(done.before, raw.length)
    assert.ok(done.after < done.before / 2, `${done.after} of ${done.before}`)
    const slim = await getPartial('norm-A', cacheOpts)
    assert.ok(Array.isArray(slim[0].messages))
    assert.ok(slim.slice(1).every((e) => e.messages === null), 'every snapshot but the seed is gone')
    // And the request the same way. Entry 0's is the only thing that can recompute this entry's
    // cache key, so a run over a whole cache dropping it would be unrecoverable.
    assert.deepEqual(slim[0].request, history[0].request)
    assert.ok(slim.slice(1).every((e) => e.request === null), 'every request but the first is gone')

    // What the file said the run held, before its say-so was thrown away: the last entry's own
    // snapshot with its round appended. The resumed request has to be that, message for message.
    const last = history.at(-1)
    const recorded = [...last.messages]
    appendToolResults(recorded, last.response, last.toolCalls, last.toolResults)
    const result = await run('norm-A', { partial: cacheOpts }, [])
    assert.equal(result.history.length, history.length + 1)
    assert.deepEqual(requests.at(-1).messages.slice(1), recorded) // slice: the adapter's own system message
  })

  it('refuses a snapshot the turns do not account for, and leaves the file alone', async () => {
    // The assertion is the whole point of doing this rather than deleting the field: a snapshot
    // that is not reproducible is one the run would come back different without.
    const cacheOpts = opts('_test-normalize-bad')
    const history = fat('norm-B', ['/0', '/1'])
    history[1].messages.push({ role: 'user', content: 'a message no turn accounts for' })
    const { path, raw } = await writeRaw('norm-B', cacheOpts, history)
    await assert.rejects(() => normalizeCacheFile(path), /entry 1's snapshot is not what replaying/u)
    assert.equal(await readFile(path, 'utf8'), raw)
  })

  it('leaves a history already in this form alone, and skips what is not one', async () => {
    const cacheOpts = opts('_test-normalize-idempotent')
    await setPartial('norm-C', fat('norm-C', ['/0', '/1']), cacheOpts)
    const path = await entryPath('norm-C', cacheOpts)
    assert.equal((await normalizeCacheFile(path)).status, 'unchanged')

    const { path: notOne } = await writeRaw('norm-D', opts('_test-normalize-other'), { reason: 'rejected' })
    assert.equal((await normalizeCacheFile(notOne)).status, 'skipped')
  })

  it('does not touch a JSON array that is not a history', async () => {
    // The rewrite spreads `{ request: null, messages: null }` over every element past the first,
    // so anything else array-shaped under a cache root — a config, an export — comes back mangled
    // and reported as a success. It is one directory argument away from someone's data.
    for (const [i, body] of [['alpha', 'beta'], [1, 2, 3], [{ id: 1, request: { keep: 'me' } }, { id: 2 }]].entries()) {
      const { path, raw } = await writeRaw(`norm-E-${i}`, opts(`_test-normalize-foreign-${i}`), body)
      assert.equal((await normalizeCacheFile(path)).status, 'skipped')
      assert.equal(await readFile(path, 'utf8'), raw)
    }
  })

  it('migrates a history that still calls its results `results`', async () => {
    // Which is every history old enough to carry per-turn snapshots: the field was renamed after
    // they came out. The replay reaches them through the same fallback a resume does, and without
    // it every file this tool exists for would be refused rather than shrunk.
    const cacheOpts = opts('_test-normalize-legacy')
    const history = fat('norm-G', ['/0', '/1', '/2'], 'results')
    const { path } = await writeRaw('norm-G', cacheOpts, history)
    assert.equal((await normalizeCacheFile(path)).status, 'normalized')
    const slim = await getPartial('norm-G', cacheOpts)
    assert.deepEqual(slim.map((e) => e.results), history.map((e) => e.results))
    assert.ok(slim.slice(1).every((e) => e.messages === null))
  })

  it('refuses to rewrite a file under an adapter other than the one that wrote it', async () => {
    // The promise the whole selectProvider machinery exists to keep. It holds because a different
    // adapter builds different message shapes and the comparison then fails — emergent, not
    // asserted, until here.
    const cacheOpts = opts('_test-normalize-wrong-provider')
    const { path, raw } = await writeRaw('norm-H', cacheOpts, fat('norm-H', ['/0', '/1']))
    process.env.ANTHROPIC_API_KEY ??= 'test-key'
    try {
      setProvider('anthropic')
      await assert.rejects(() => normalizeCacheFile(path), /is not what replaying the new file produces/u)
      assert.equal(await readFile(path, 'utf8'), raw)
    } finally {
      setProvider('openrouter')
    }
  })

  it('walks a directory, leaving what is not a history and what is already slim', async () => {
    // The half a caller of the package needs to migrate its own cache, and the half the script no
    // longer has to re-derive: which files are histories, and what happened to each.
    const cacheOpts = opts('_test-normalize-walk')
    await writeRaw('walk-A', cacheOpts, fat('walk-A', ['/0', '/1']))
    await writeRaw('walk-B', cacheOpts, ['not', 'a history'])
    await setPartial('walk-C', fat('walk-C', ['/0']), cacheOpts)
    const keys = Object.fromEntries(await Promise.all(
      ['A', 'B', 'C'].map(async (n) => [n, await cacheKey('sys', `walk-${n}`, cacheOpts)]),
    ))
    const seen = new Map()
    for await (const { path, status, error } of normalizeCache(cacheDir())) {
      for (const [name, key] of Object.entries(keys)) if (path.includes(key)) seen.set(name, error ?? status)
    }
    assert.deepEqual([...seen.entries()].sort(), [['A', 'normalized'], ['B', 'skipped'], ['C', 'unchanged']])
  })

  it('yields a file it could not rewrite rather than stopping the walk', async () => {
    const cacheOpts = opts('_test-normalize-walk-bad')
    const history = fat('walk-D', ['/0', '/1'])
    history[1].messages.push({ role: 'user', content: 'a message no turn accounts for' })
    const { raw } = await writeRaw('walk-D', cacheOpts, history)
    await writeRaw('walk-E', cacheOpts, fat('walk-E', ['/0', '/1']))
    const [keyD, keyE] = await Promise.all([cacheKey('sys', 'walk-D', cacheOpts), cacheKey('sys', 'walk-E', cacheOpts)])
    const results = []
    for await (const result of normalizeCache(cacheDir())) {
      if (result.path.includes(keyD)) results.push(['D', result.error?.message])
      if (result.path.includes(keyE)) results.push(['E', result.status])
    }
    assert.equal(results.length, 2)
    assert.match(results.find(([n]) => n === 'D')[1], /entry 1's snapshot is not what replaying/u)
    assert.equal(results.find(([n]) => n === 'E')[1], 'normalized')
    assert.equal(await readFile(await entryPath('walk-D', cacheOpts), 'utf8'), raw)
  })

  it('hands the entries\' provider stamp over before replaying anything', async () => {
    // A directory can hold files more than one provider wrote, and the replay builds whatever
    // shapes the adapter that is set builds. The caller is told which one, once, per file.
    const cacheOpts = opts('_test-normalize-stamp')
    const { path } = await writeRaw('norm-F', cacheOpts, fat('norm-F', ['/0', '/1']))
    const seen = []
    await normalizeCacheFile(path, { selectProvider: (stamp) => seen.push(stamp) })
    assert.deepEqual(seen, [providerStamp(MODEL)])
  })
})

suite('chat: what a conversation cost', () => {
  it('prices each request on its own prompt, not the conversation\'s sum of them', async () => {
    // gpt-5.5 bills past 272K of prompt at a higher tier. The first turn is
    // under that line and the second past it — and the two together would
    // be past it too, which is the sum a caller would otherwise be pricing.
    const sized = (response, promptTokens) => ({ ...response, usage: { prompt_tokens: promptTokens, completion_tokens: 1000, cost: 0 } })
    const result = await run('cost-A', { model: 'openai/gpt-5.5' }, [sized(TOOL_CALL, 200_000), sized(ANSWER, 300_000)])
    assert.equal(result.text, 'done')
    const turn = (promptTokens) => calculateCost('openai/gpt-5.5', { input: promptTokens, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 })
    assert.equal(result.usage.cost, turn(200_000) + turn(300_000))
    assert.ok(calculateCost('openai/gpt-5.5', result.usage) > result.usage.cost)
  })

  it('keeps the provider\'s own number where it sends one', async () => {
    const reported = { ...ANSWER, usage: { prompt_tokens: 200_000, completion_tokens: 1000, cost: 0.42 } }
    const result = await run('cost-B', { model: 'openai/gpt-5.5' }, [reported])
    assert.equal(result.usage.cost, 0.42)
  })
})
