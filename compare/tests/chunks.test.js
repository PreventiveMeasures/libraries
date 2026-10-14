import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareTrees } from '../compare.js'

// Bundle chunks a build renamed, the hash in a name following its content:
// minified onto one line, which git scores in 64-byte runs that any edit
// shifts, so that git's own -M finds none of them.

const statements = (from, to) => Array.from({ length: to - from }, (_, j) => `s${from + j}=g(${from + j},"k${from + j}");`).join('')
// A chunk, and the next build's: a statement put in front, every run shifted.
// Kept 90 of 100 statements scores 86% split at punctuation, 60 of them 51%
// and 70 of them 62%; all score 0% as git splits them.
const OLD = statements(0, 100)
const kept = (n) => `x=1;${statements(0, n)}${statements(1000, 1100 - n)}`
const NEW = kept(90)

const tree = (files) => Object.entries(files).map(([name, data]) => ({ name, data }))
const renames = (old, fresh, options) => compareTrees(tree(old), tree(fresh), { lines: false, ...options })
  .map(({ status, old: from, new: to, similarity }) => (status === 'renamed' ? `${from.path} -> ${to.path} ${similarity}%` : `${status} ${(to ?? from).path}`))

describe('bundle chunks', () => {
  it('pairs a chunk whose hash changed, in its directory, whatever extensions follow the hash, scored split at punctuation', () => {
    for (const [from, to] of [
      ['assets/index-CyWAfh-p.js', 'assets/index-hRvO4yU2.js'],
      ['assets/codeMirrorModule--QdMvsKi.js', 'assets/codeMirrorModule-CVQWJZAA.js'],
      ['traceViewer/uiMode.Dzuouizj.js', 'traceViewer/uiMode.CU5KtEkS.js'],
      ['static/chunks/main_3f9a2c1d.js', 'static/chunks/main_8b7e6a5f.js'],
      ['index-AbCdEf12.mjs', 'index-ZyXwVu98.mjs'],
      ['static/js/main.3f9a2c1d.chunk.js', 'static/js/main.8b7e6a5f.chunk.js'],
      ['assets/index-CyWAfh-p.js.map', 'assets/index-hRvO4yU2.js.map'],
    ]) assert.deepEqual(renames({ [from]: OLD }, { [to]: NEW }), [`${from} -> ${to} 86%`], `${from} -> ${to}`)
  })

  it('pairs stylesheets alike', () => {
    const rules = Array.from({ length: 60 }, (_, i) => `.c${i}{padding:${i}px;color:#${i}}`).join('')
    assert.deepEqual(renames({ 'a/uiMode.C7UW1sC9.css': `.a{color:red}.b{margin:0}${rules}` }, { 'a/uiMode.CyMfwkXJ.css': `.z{top:0}${rules}` }), ['a/uiMode.C7UW1sC9.css -> a/uiMode.CyMfwkXJ.css 98%'])
  })

  it('looks for none with renamesByPath false, as git finds none', () => {
    assert.deepEqual(renames({ 'assets/index-CyWAfh-p.js': OLD }, { 'assets/index-hRvO4yU2.js': NEW }, { renamesByPath: false }), ['deleted assets/index-CyWAfh-p.js', 'added assets/index-hRvO4yU2.js'])
  })

  it('pairs no names that are not one chunk with its hash changed', () => {
    for (const [from, to] of [
      ['a/index-CyWAfh-p.js', 'b/index-hRvO4yU2.js'],
      ['a/index-CyWAfh-p.js', 'a/index-hRvO4yU2.mjs'],
      ['a/index-CyWAfh-p.js', 'a/vendor-hRvO4yU2.js'],
      ['a/index-CyWAfh-p.js', 'a/index-hRvO4yU2x.js'],
      ['a/index-Cy3Af.js', 'a/index-hR4O4.js'],
      ['a/button-primary.js', 'a/button-success.js'],
      ['a/CyWAfh-p.js', 'a/hRvO4yU2.js'],
      ['a/index.CyWAfh+p.js', 'a/index.hRvO4y+2.js'],
      ['a/index+CyWAfh-p.js', 'a/index+hRvO4yU2.js'],
      ['a/main.AbCdEf12.chunk.js', 'a/main.ZyXwVu98.lazy0.js'],
      ['a/index-CyWAfh-p.cjs.map', 'a/index-hRvO4yU2.mjs.map'],
    ]) assert.deepEqual(renames({ [from]: OLD }, { [to]: NEW }).toSorted(), [`added ${to}`, `deleted ${from}`].toSorted(), `${from} -> ${to}`)
  })

  it('pairs a chunk with the only other of its name however it scores, as a pair by path', () => {
    // playwright-core's dashboard `index-*.js`, 31% alike from 1.61.1 to 1.62.0: the build's own chunk, rewritten.
    const old = { 'a/index-CyWAfh-p.js': OLD }
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': kept(60) }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 51%'])
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': statements(7000, 7100) }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 0%'], 'nothing alike')
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': NEW }, { renames: 100 }), ['deleted a/index-CyWAfh-p.js', 'added a/index-hRvO4yU2.js'], 'none under -M100%')
    assert.deepEqual(renames({ 'a/codeMirrorModule--QdMvsKi.css': OLD }, { 'a/codeMirrorModule-DYBRYzYX.css': kept(60) }), ['a/codeMirrorModule--QdMvsKi.css -> a/codeMirrorModule-DYBRYzYX.css 51%'], 'a hash that starts with `-`')
  })

  it('holds to git\'s stricter score the only other of a name its hash alone does not tell', () => {
    // A hash's last 8 to 32 characters with a letter, and a digit or a capital: a date has none, and a `-`
    // before eight more is the name's, two chunks named apart (`vendor-react-dom`, `vendor-lodash-es`).
    for (const [from, to] of [
      ['a/migration-20240101.js', 'a/migration-20250101.js'],
      ['a/vendor-react-dom-AbCd1234.js', 'a/vendor-lodash-es-XyZw5678.js'],
      ['a/vendor-ui-AbCdEf12-GhIjKl34.js', 'a/vendor-db-Zy98XwVu-TsRq7654.js'],
      ['a/index-AbCdEf12-GhIjKl34.js', 'a/index-Zy98XwVu-TsRq7654.js'],
      ['a/main_3f9a2c1d.js', 'a/main_8b7e6a5f.js'],
    ]) {
      assert.deepEqual(renames({ [from]: OLD }, { [to]: kept(60) }).toSorted(), [`added ${to}`, `deleted ${from}`].toSorted(), `${from} -> ${to}, 51%`)
      assert.deepEqual(renames({ [from]: OLD }, { [to]: NEW }), [`${from} -> ${to} 86%`], `${from} -> ${to}, 86%`)
    }
  })

  it('holds chunks of a name either side has more of to git\'s stricter score, halfway from -M to 100%, as their names alone put them forward', () => {
    const old = { 'a/index-AAAA1111.js': OLD, 'a/index-BBBB2222.js': statements(5000, 5100) }
    const fresh = (n) => ({ 'a/index-CCCC3333.js': kept(n), 'a/index-DDDD4444.js': statements(7000, 7100) })
    const none = ['deleted a/index-AAAA1111.js', 'deleted a/index-BBBB2222.js', 'added a/index-CCCC3333.js', 'added a/index-DDDD4444.js']
    assert.deepEqual(renames(old, fresh(60)).toSorted(), none.toSorted(), '51% is short of 75%')
    assert.deepEqual(renames(old, fresh(70), { renames: 30 }).toSorted(), none.toSorted(), '62% is short of 65%')
    assert.deepEqual(renames(old, fresh(70), { renames: 20 }).toSorted(), ['a/index-AAAA1111.js -> a/index-CCCC3333.js 62%', 'deleted a/index-BBBB2222.js', 'added a/index-DDDD4444.js'].toSorted(), '62% is past 60%')
  })

  it('takes the best pairs first among chunks of one name', () => {
    const other = statements(5000, 5100)
    const old = { 'a/index-AAAA1111.js': OLD, 'a/index-BBBB2222.js': other }
    const fresh = { 'a/index-CCCC3333.js': `x=1;${other}`, 'a/index-DDDD4444.js': NEW }
    assert.deepEqual(renames(old, fresh), ['a/index-BBBB2222.js -> a/index-CCCC3333.js 99%', 'a/index-AAAA1111.js -> a/index-DDDD4444.js 86%'])
  })

  it('looks for none past the rename limit, which counts every file left in a group, as git scores none', () => {
    const fresh = { 'a/index-hRvO4yU2.js': NEW, 'b/index-hRvO4yU2.js': NEW }, old = { 'a/index-CyWAfh-p.js': OLD, 'b/index-CyWAfh-p.js': OLD }
    assert.deepEqual(renames(old, fresh, { renameLimit: 1 }), ['deleted a/index-CyWAfh-p.js', 'added a/index-hRvO4yU2.js', 'deleted b/index-CyWAfh-p.js', 'added b/index-hRvO4yU2.js'])
    assert.deepEqual(renames(old, fresh, { renameLimit: 2 }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 86%', 'b/index-CyWAfh-p.js -> b/index-hRvO4yU2.js 86%'])
  })

  it('pairs a chunk before git scores the files left, so that no file elsewhere takes its other version', () => {
    // Most of it as git splits it, against none of the chunk's other version.
    const legacy = `x=1;${statements(0, 70)}${statements(5000, 5030)}`
    assert.deepEqual(renames({ 'a/index-CyWAfh-p.js': OLD, 'b/legacy.js': legacy }, { 'a/index-hRvO4yU2.js': NEW }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 86%', 'deleted b/legacy.js'])
    assert.deepEqual(renames({ 'a/index-CyWAfh-p.js': OLD }, { 'a/index-hRvO4yU2.js': NEW, 'b/legacy.js': legacy }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 86%', 'added b/legacy.js'])
    assert.deepEqual(renames({ 'a/index-CyWAfh-p.js': OLD, 'b/legacy.js': legacy }, { 'a/index-hRvO4yU2.js': NEW }, { renamesByPath: false }), ['deleted a/index-CyWAfh-p.js', 'b/legacy.js -> a/index-hRvO4yU2.js 62%'])
  })

  it('gives way to identical content, or to a candidate halfway closer to 100% than the pair, as a pair by path does', () => {
    const old = { 'a/index-CyWAfh-p.js': OLD }
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': NEW, 'b/copy.js': OLD }), ['added a/index-hRvO4yU2.js', 'a/index-CyWAfh-p.js -> b/copy.js 100%'])
    // 86% for the chunk, against 94% for another deleted file, past 93, or 90%, short of it.
    const near = (k) => `x=1;${statements(0, 90)}${statements(1000, 1000 + k)}${statements(5000, 5010 - k)}`
    assert.deepEqual(renames({ ...old, 'b/near.js': near(6) }, { 'a/index-hRvO4yU2.js': NEW }), ['deleted a/index-CyWAfh-p.js', 'b/near.js -> a/index-hRvO4yU2.js 94%'])
    assert.deepEqual(renames({ ...old, 'b/near.js': near(3) }, { 'a/index-hRvO4yU2.js': NEW }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 86%', 'deleted b/near.js'])
  })

  it('pairs a chunk after all where git pairs the candidate it gave way to with another file', () => {
    // 95% for the old chunk against another added file, which git gives a deleted one 97% like it.
    const other = `S${OLD.slice(1)}`
    const fresh = { 'a/index-hRvO4yU2.js': NEW, 'b/other.js': other }, old = { 'a/index-CyWAfh-p.js': OLD, 'c/legacy.js': `${other.slice(0, -1)}#` }
    assert.deepEqual(renames(old, fresh), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 86%', 'c/legacy.js -> b/other.js 97%'])
  })

  it('keeps the files of a chunk that gave way from a worse pair of either until git has paired the rest', () => {
    // 86% and 76% for the old chunk; the first gives way to a deleted file 94% like the new one, which git
    // gives an added file 97% like it, or else takes.
    const rival = `x=1;${statements(0, 90)}${statements(1000, 1006)}${statements(5000, 5004)}`
    const fresh = { 'a/index-BBBB2222.js': NEW, 'a/index-CCCC3333.js': kept(82) }, old = { 'a/index-AAAA1111.js': OLD, 'b/rival.js': rival }
    assert.deepEqual(renames(old, { ...fresh, 'c/closer.js': `${rival.slice(0, -1)}#` }), ['a/index-AAAA1111.js -> a/index-BBBB2222.js 86%', 'added a/index-CCCC3333.js', 'b/rival.js -> c/closer.js 97%'])
    assert.deepEqual(renames(old, fresh), ['b/rival.js -> a/index-BBBB2222.js 94%', 'a/index-AAAA1111.js -> a/index-CCCC3333.js 76%'])
  })

  it('takes a chunk that gave way before git pairs either of its files at a score that could not outdo it', () => {
    // As above, with an added file elsewhere that git scores 62% like the old chunk.
    const rival = `x=1;${statements(0, 90)}${statements(1000, 1006)}${statements(5000, 5004)}`
    const fresh = { 'a/index-BBBB2222.js': NEW, 'e/part.js': `${statements(0, 70)}${statements(8000, 8030)}` }, old = { 'a/index-AAAA1111.js': OLD, 'b/rival.js': rival }
    assert.deepEqual(renames(old, { ...fresh, 'c/closer.js': `${rival.slice(0, -1)}#` }), ['a/index-AAAA1111.js -> a/index-BBBB2222.js 86%', 'b/rival.js -> c/closer.js 97%', 'added e/part.js'])
    assert.deepEqual(renames(old, fresh), ['b/rival.js -> a/index-BBBB2222.js 94%', 'a/index-AAAA1111.js -> e/part.js 62%'])
  })
})
