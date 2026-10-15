// A scripted ask() for the phases to run against: it answers every prompt the package sends, in
// the shape asked for, from the text alone. A row matches when its entry carries the word MATCH,
// which the compaction copies into the summary, so the same rule drives every phase and a test can
// name the expected result up front. What the fake was asked is kept in `log`, request by request.
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0.001 }

const blocksOf = (userContent) => (Array.isArray(userContent) ? userContent : [userContent])

const countQuestions = (systemPrompt) => (systemPrompt.match(/^[qx]\d+\. /gmu) ?? []).length

function compactAnswer(request) {
  const text = blocksOf(request.userContent).join('').replace(/^Entry:\n/u, '')
  const count = countQuestions(request.systemPrompt)
  const answers = Array.from({ length: count }, (_, i) => `a${i + 1} of ${text.split(':')[0]}`)
  const summary = `Summary of ${text.split(':')[0]}${text.includes('MATCH') ? ' MATCH' : ''}`
  return request.systemPrompt.includes('"summary"') ? { summary, answers } : { answers }
}

// The rows of a page, as `[ordinal, text]`, in either rendering.
function pageRows(page) {
  const body = page.slice(page.indexOf('Rows:\n') + 6)
  if (page.includes('Each row') || !body.startsWith('[')) {
    return [...body.matchAll(/^(\d+)\. (.*)$/gmu)].map((m) => [Number(m[1]), m[2]])
  }
  const parts = body.split(/^\[(\d+)\]$/mu)
  const rows = []
  for (let i = 1; i < parts.length; i += 2) rows.push([Number(parts[i]), parts[i + 1]])
  return rows
}

function searchAnswer(request) {
  const page = blocksOf(request.userContent).find((block) => block.startsWith('Page of'))
  const picks = pageRows(page).filter(([, text]) => text.includes('MATCH')).map(([n]) => ({ n, score: 9 }))
  return { picks }
}

function scoreAnswer(request) {
  const candidate = blocksOf(request.userContent).find((block) => block.startsWith('Candidate:'))
  return candidate.includes('MATCH') ? { score: 90, reason: 'carries MATCH' } : { score: 10, reason: 'no MATCH' }
}

export function fakeAsk({ gate = {}, propose = {}, log = [], override } = {}) {
  return (request) => {
    log.push(request)
    const forced = override?.(request)
    if (forced !== undefined) return Promise.resolve({ text: forced, usage: USAGE, history: [] })
    const { systemPrompt } = request
    let json
    if (systemPrompt.startsWith('You design')) json = { focus: 'the colour', questions: ['Colour?', 'Size?'], ...propose }
    else if (systemPrompt.startsWith('You compact')) json = compactAnswer(request)
    else if (systemPrompt.startsWith('A dataset was compacted')) json = { extraQuestions: [], fullScan: false, reason: 'enough', ...gate }
    else if (systemPrompt.startsWith('You select')) json = searchAnswer(request)
    else if (systemPrompt.startsWith('You judge')) json = scoreAnswer(request)
    else return Promise.reject(new Error(`fake ask: unknown prompt ${systemPrompt.slice(0, 40)}`))
    return Promise.resolve({ text: JSON.stringify(json), usage: USAGE, history: [] })
  }
}

// `count` entries named e1..eN, the ones in `matches` carrying the word.
export const entriesOf = (count, matches) => Array.from({ length: count }, (_, i) => {
  const id = `e${i + 1}`
  return { id, text: `${id}: entry number ${i + 1}${matches.includes(id) ? ' MATCH' : ''}` }
})

export const TASK = { id: 'colours', prompt: 'Find entries about the request.', question: 'Which entries match the request?' }
