import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { md5Base32 } from '../src/hash.js'

// RFC 4648's base32 of node's own MD5, lowercased and unpadded, as pnpm 9's
// createBase32Hash spells it.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
function expected(text) {
  let bits = ''
  for (const byte of createHash('md5').update(text, 'utf8').digest()) bits += byte.toString(2).padStart(8, '0')
  return bits.padEnd(Math.ceil(bits.length / 5) * 5, '0').match(/.{5}/gu).map((chunk) => ALPHABET[Number.parseInt(chunk, 2)]).join('')
}

describe('md5Base32', () => {
  it('hashes as node\'s MD5 does, across a block\'s every boundary', () => {
    const texts = ['', 'a', 'abc', 'message digest', 'é😀', 'react-dom@18.2.0_react@18.2.0']
    for (let length = 50; length <= 130; length++) texts.push('x'.repeat(length))
    for (const text of texts) assert.equal(md5Base32(text), expected(text), JSON.stringify(text))
    assert.equal(md5Base32('abc'), 'saavbgb42jh3bvuwh56sryl7oi')
  })

  it('refuses text that is not well-formed', () => {
    assert.throws(() => md5Base32('\uD800', 'x'), /^DeptreeError: x: expected well-formed text to hash$/u)
  })
})
