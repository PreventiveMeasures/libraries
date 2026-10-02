import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

// npm's own packages, from the npm beside node, as the reference to hold
// this reader to: npm-package-arg, which reads a spec, and Arborist, which
// loads a lockfile into a tree. POSIX keeps npm in <prefix>/lib beside
// <prefix>/bin/node; Windows, beside node.exe.
const require = createRequire(import.meta.url)

const modules = ['../lib', '.'].map((prefix) => resolve(dirname(process.execPath), prefix, 'node_modules/npm/node_modules')).find((dir) => {
  try {
    require.resolve(`${dir}/npm-package-arg`)
    return true
  } catch {
    return false
  }
})
if (modules === undefined) throw new Error('no npm beside node to borrow npm-package-arg and Arborist from')

export const npa = require(`${modules}/npm-package-arg`)
export const Arborist = require(`${modules}/@npmcli/arborist`)
export const calcDepFlags = require(`${modules}/@npmcli/arborist/lib/calc-dep-flags.js`)
export const resetDepFlags = require(`${modules}/@npmcli/arborist/lib/reset-dep-flags.js`)
