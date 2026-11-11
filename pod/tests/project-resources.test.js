import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { newGroup, newProject } from '../src/generate/project.js'
import { addKnownRegions, addLocalized, allowablePaths, mergeDocc, resourceRefs } from '../src/generate/project-resources.js'

// What the fixtures hold too, of CocoaPods 1.16.2's own output; here by the case, and what no fixture has.
const listOf = (files, dirs) => ({ files, dirs })

describe('allowablePaths', () => {
  const list = listOf([], ['res/en.lproj', 'res/fr.lproj', 'res/en.lproj/deep', 'M.xcdatamodeld', 'A.xcassets', 'src/D.docc', 'src/D.docc/Resources'])

  it('takes an .lproj directory only where no file of it is taken, after all the others', () => {
    assert.deepEqual(allowablePaths(list, ['res/en.lproj', 'res/fr.lproj', 'res/x.png']), ['res/x.png', 'res/en.lproj', 'res/fr.lproj'])
    assert.deepEqual(allowablePaths(list, ['res/en.lproj', 'res/en.lproj/a.strings', 'res/fr.lproj', 'res/x.png']), ['res/en.lproj/a.strings', 'res/x.png', 'res/fr.lproj'])
    // A directory in one is taken as its files are, and is a file of it.
    assert.deepEqual(allowablePaths(list, ['res/en.lproj', 'res/en.lproj/deep', 'res/en.lproj/deep/d.txt']), ['res/en.lproj/deep', 'res/en.lproj/deep/d.txt'])
  })

  it('takes the directory of a data model and of an asset catalog, and nothing in it', () => {
    assert.deepEqual(allowablePaths(list, ['M.xcdatamodeld', 'M.xcdatamodeld/M.xcdatamodel', 'A.xcassets', 'A.xcassets/Contents.json', 'M.XCMAPPINGMODEL/x']), ['M.xcdatamodeld', 'A.xcassets'])
  })

  it('takes a documentation catalog as its directory, once, for the files in it', () => {
    assert.deepEqual(mergeDocc(list, ['src/a.m', 'src/D.docc', 'src/D.docc/D.md', 'src/D.docc/Resources', 'src/D.docc/Resources/p.png', 'src/b.md']), ['src/a.m', 'src/b.md', 'src/D.docc'])
    assert.deepEqual(allowablePaths(list, ['src/D.docc/D.md', 'src/a.m']), ['src/a.m', 'src/D.docc'])
    // The directory alone, with no file of it taken, is nothing.
    assert.deepEqual(mergeDocc(list, ['src/D.docc']), [])
  })
})

describe('addLocalized', () => {
  const made = (files) => {
    const project = newProject('/p/Pods', { Debug: 'debug' }, '56', '15.1')
    const group = newGroup(project.mainGroup, 'Pod', '/p/Pods/Pod')
    return { project, group, target: { dir: '/p/Pods/Pod', list: listOf(files, []) } }
  }

  it('holds the files of one name in one variant group, by the directory their .lproj are in', () => {
    const { project, group, target } = made(['a/en.lproj/L.strings', 'a/fr.lproj/L.strings', 'b/en.lproj/L.strings'])
    const refs = target.list.files.map((path) => addLocalized(project, group, target, path))
    assert.deepEqual(group.children.map((child) => [child.isa, child.name, child.path, child.children.map((ref) => ref.path)]), [
      ['PBXVariantGroup', 'L.strings', 'a', ['en.lproj/L.strings', 'fr.lproj/L.strings']],
      ['PBXVariantGroup', 'L.strings', 'b', ['en.lproj/L.strings']],
    ])
    assert.deepEqual(refs.map((ref) => [ref.name, ref.lastKnownFileType]), [['L.strings', 'text.plist.strings'], ['L.strings', 'text.plist.strings'], ['L.strings', 'text.plist.strings']])
    // Asked for again, a file is the reference it has.
    assert.equal(addLocalized(project, group, target, 'a/fr.lproj/L.strings'), refs[1])
    assert.equal(group.children[0].children.length, 2)
  })

  it('names the group of an interface file\'s .strings after the file of Base.lproj, in whichever case that is', () => {
    const { project, group, target } = made(['ui/base.lproj/Main.storyboard', 'ui/Base.lproj/View.xib', 'ui/fr.lproj/Main.strings', 'ui/fr.lproj/View.strings', 'ui/fr.lproj/Other.strings', 'ui/fr.lproj/Main.txt'])
    const nameOf = (path) => addLocalized(project, group, target, path)._variant.name
    assert.deepEqual(['ui/fr.lproj/Main.strings', 'ui/fr.lproj/View.strings', 'ui/fr.lproj/Other.strings', 'ui/fr.lproj/Main.txt', 'ui/Base.lproj/View.xib'].map(nameOf), ['Main.storyboard', 'View.xib', 'Other.strings', 'Main.txt', 'View.xib'])
    assert.equal(group.children.length, 4)
  })

  it('gives a phase the group, once, for the files in it; and what is compiled apart', () => {
    const { project, group, target } = made(['a/en.lproj/L.strings', 'a/fr.lproj/L.strings'])
    for (const path of target.list.files) addLocalized(project, group, target, path)
    const model = { isa: 'PBXFileReference', path: 'M.xcdatamodeld' }
    const plain = { isa: 'PBXFileReference', path: 'x.png' }
    project.refs.set('/p/Pods/Pod/M.xcdatamodeld', model)
    project.refs.set('/p/Pods/Pod/x.png', plain)
    const { compiled, copied } = resourceRefs(project, target, ['a/en.lproj', 'a/en.lproj/L.strings', 'x.png', 'a/fr.lproj/L.strings', 'M.xcdatamodeld', 'M.xcdatamodeld/M.xcdatamodel', 'x.png'])
    assert.deepEqual(compiled, [model])
    assert.deepEqual(copied, [group.children[0], plain])
  })
})

describe('addKnownRegions', () => {
  it('adds the regions of the references\' .lproj directories to the project\'s, in the order of their bytes', () => {
    const project = newProject('/p/Pods', { Debug: 'debug' }, '56', '15.1')
    addKnownRegions(project, [])
    assert.deepEqual(project.root.knownRegions, ['Base', 'en'])
    // By the first .lproj of a path; one in another case is no region, as CocoaPods has it.
    addKnownRegions(project, ['fr.lproj/L.strings', 'Pod/dirs/zh-Hans.lproj', 'en.lproj/deep/d.txt', 'de.lproj', 'x.png', 'UP/IT.LPROJ/U.strings', 'a/pt-BR.lproj/b/ja.lproj/c'].map((path) => ({ path })))
    assert.deepEqual(project.root.knownRegions, ['Base', 'de', 'en', 'fr', 'pt-BR', 'zh-Hans'])
  })
})
