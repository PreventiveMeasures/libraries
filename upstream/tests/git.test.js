import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { findGitCheckout } from '../git.js'

const SHA = '3f786850e387550fdab836ed7e6dc881de23001b'
const SHA2 = '89e6c98d92887913cadf06b2adb97f26cde4849b'

const base = await mkdtemp(join(tmpdir(), 'upstream-git-test-'))
let count = 0

after(async () => {
  await rm(base, { recursive: true, force: true })
})

// A checkout on disk, from a map of paths under it to file contents.
async function checkout(files) {
  const root = join(base, `repo-${++count}`)
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}

const config = (url) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`

describe('findGitCheckout', () => {
  it('answers the commit, the directory within the checkout, and the GitHub repo', async () => {
    const root = await checkout({
      '.git/HEAD': 'ref: refs/heads/feat/x\n',
      '.git/refs/heads/feat/x': `${SHA}\n`,
      '.git/config': config('https://github.com/acme/app.git'),
      'packages/pkg/src/index.js': '',
    })
    assert.deepEqual(await findGitCheckout(join(root, 'packages/pkg')), { commit: SHA, directory: 'packages/pkg', github: 'acme/app' })
    assert.deepEqual(await findGitCheckout(root), { commit: SHA, directory: '', github: 'acme/app' })
  })

  it('reads a detached HEAD, and a ref from packed-refs', async () => {
    const detached = await checkout({ '.git/HEAD': `${SHA2}\n` })
    assert.deepEqual(await findGitCheckout(detached), { commit: SHA2, directory: '' })
    const packed = await checkout({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA2} refs/heads/dev\n${SHA} refs/heads/main\n^${SHA2}\n`,
    })
    assert.equal((await findGitCheckout(packed)).commit, SHA)
  })

  it('follows a `.git` file to its gitdir, and a worktree to its common dir', async () => {
    const root = await checkout({
      'main/.git/config': config('git@github.com:acme/app.git'),
      'main/.git/refs/heads/main': `${SHA}\n`,
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/main\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
      'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
      'wt/lib/a.js': '',
    })
    assert.deepEqual(await findGitCheckout(join(root, 'wt/lib')), { commit: SHA, directory: 'lib', github: 'acme/app' })
  })

  it('answers where the directory really is, through a symlink', async () => {
    const root = await checkout({ '.git/HEAD': `${SHA}\n`, 'deep/dir/a.js': '' })
    const link = join(base, `link-${++count}`)
    await symlink(join(root, 'deep'), link)
    assert.deepEqual(await findGitCheckout(join(link, 'dir')), { commit: SHA, directory: 'deep/dir' })
  })

  it('names the GitHub repo off the origin URL in any spelling git writes, and never the URL', async () => {
    const urls = [
      'https://github.com/acme/app',
      'https://github.com/acme/app.git',
      'https://x-access-token:ghp_secret@github.com/acme/app.git',
      'git@github.com:acme/app.git',
      'ssh://git@github.com/acme/app.git',
      'git://github.com/acme/app',
    ]
    for (const url of urls) {
      const result = await findGitCheckout(await checkout({ '.git/HEAD': `${SHA}\n`, '.git/config': config(url) }))
      assert.deepEqual(result, { commit: SHA, directory: '', github: 'acme/app' }, url)
      assert.doesNotMatch(JSON.stringify(result), /secret|x-access-token|github\.com/u)
    }
  })

  it('has no github for another host, another remote, or an origin not written the way git writes it', async () => {
    const configs = [
      config('https://gitlab.com/acme/app.git'),
      config('https://git.internal.example/acme/app.git'),
      config('https://github.com.evil.example/acme/app'),
      config('https://github.com/acme/..'),
      config('/srv/git/app.git'),
      '[remote "upstream"]\n\turl = https://github.com/acme/app.git\n',
      '[remote "origin"]\n    url = https://github.com/acme/app.git\n',
      '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      '',
    ]
    for (const text of configs) {
      assert.deepEqual(await findGitCheckout(await checkout({ '.git/HEAD': `${SHA}\n`, '.git/config': text })), { commit: SHA, directory: '' }, text)
    }
  })

  it('answers null where there is no checkout, or no HEAD it can read', async () => {
    const heads = ['', 'ref: refs/heads/missing\n', 'ref: ../../../etc/passwd\n', 'ref: refs/../../x\n', 'ref: HEAD\n', 'abc123\n', `${SHA.toUpperCase()}\n`]
    for (const head of heads) {
      assert.equal(await findGitCheckout(await checkout({ '.git/HEAD': head })), null, head)
    }
    assert.equal(await findGitCheckout(await checkout({ '.git/config': config('https://github.com/acme/app') })), null)
    assert.equal(await findGitCheckout(await checkout({ '.git': 'gitdir: ./nowhere\n' })), null)
    assert.equal(await findGitCheckout(await checkout({ '.git': 'not a pointer\n' })), null)
    assert.equal(await findGitCheckout(join(base, 'does-not-exist')), null)
    const file = join(await checkout({ '.git/HEAD': `${SHA}\n`, 'a.txt': '' }), 'a.txt')
    assert.equal(await findGitCheckout(file), null)
  })

  it('refuses a dir that is not a path', async () => {
    for (const dir of [undefined, '', 42, ['.']]) {
      await assert.rejects(findGitCheckout(dir), /findGitCheckout: dir must be a directory path/u, String(dir))
    }
  })
})
