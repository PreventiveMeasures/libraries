import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { allows, normalize, parseConstraints } from '../../composer-semver.js'

// The entry point, on constraints as Packagist's security advisories write
// them; differential.test.js holds the matching to Composer itself.
describe('composer-semver.js', () => {
  it('reads `|` as or, `,` as and, and matches normalized versions as Composer does', () => {
    const constraint = parseConstraints('>=2.8.44,<3.0.0|>=3.4.14,<4.0.0|>=7.4.0,<7.4.12')
    const inside = (version) => allows(constraint, normalize(version))
    assert.deepEqual(['2.8.43', '2.8.44', 'v2.9', '3.0.0', '3.4.14', '4.0.0', '7.4.11', '7.4.12'].map(inside), [false, true, true, false, true, false, true, false])
    assert.ok(allows(parseConstraints('<1.0.0-RC1'), normalize('1.0.0-beta2')))
    assert.ok(!allows(parseConstraints('<1.0.0-RC1'), normalize('1.0.0')))
  })

  it("normalizes as Composer does, and is undefined for what Composer refuses", () => {
    assert.deepEqual(['v1.2', '1.2.3.4', '2.0.0-RC2', '1.0.0-p1', 'dev-main'].map(normalize), ['1.2.0.0', '1.2.3.4', '2.0.0.0-RC2', '1.0.0.0-patch1', 'dev-main'])
    assert.equal(normalize('not a version'), undefined)
    assert.equal(parseConstraints('>=1.0,<'), undefined)
  })
})
