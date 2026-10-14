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
  it('pairs a chunk whose hash changed, in its directory, scored split at punctuation', () => {
    for (const [from, to] of [
      ['assets/index-CyWAfh-p.js', 'assets/index-hRvO4yU2.js'],
      ['assets/codeMirrorModule--QdMvsKi.js', 'assets/codeMirrorModule-CVQWJZAA.js'],
      ['traceViewer/uiMode.Dzuouizj.js', 'traceViewer/uiMode.CU5KtEkS.js'],
      ['static/chunks/main_3f9a2c1d.js', 'static/chunks/main_8b7e6a5f.js'],
      ['index-AbCdEf12.mjs', 'index-ZyXwVu98.mjs'],
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
    ]) assert.deepEqual(renames({ [from]: OLD }, { [to]: NEW }).toSorted(), [`added ${to}`, `deleted ${from}`].toSorted(), `${from} -> ${to}`)
  })

  it('holds a chunk to git\'s stricter score, halfway from -M to 100%, as its name alone puts it forward', () => {
    const old = { 'a/index-CyWAfh-p.js': OLD }
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': kept(60) }), ['deleted a/index-CyWAfh-p.js', 'added a/index-hRvO4yU2.js'], '51% is short of 75%')
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': kept(70) }, { renames: 30 }), ['deleted a/index-CyWAfh-p.js', 'added a/index-hRvO4yU2.js'], '62% is short of 65%')
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': kept(70) }, { renames: 20 }), ['a/index-CyWAfh-p.js -> a/index-hRvO4yU2.js 62%'], '62% is past 60%')
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': NEW }, { renames: 100 }), ['deleted a/index-CyWAfh-p.js', 'added a/index-hRvO4yU2.js'], 'none under -M100%')
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

  it('pairs only what no other pass claimed', () => {
    const old = { 'a/index-CyWAfh-p.js': OLD }
    assert.deepEqual(renames(old, { 'a/index-hRvO4yU2.js': NEW, 'b/copy.js': OLD }), ['added a/index-hRvO4yU2.js', 'a/index-CyWAfh-p.js -> b/copy.js 100%'])
  })
})
