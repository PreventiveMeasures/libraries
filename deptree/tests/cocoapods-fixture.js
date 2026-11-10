// The fixture the CocoaPods tests share: a repo's tarball as GitHub serves
// it, its podspec as trunk would, and lockfiles as CocoaPods writes them.
import { createHash } from 'node:crypto'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { commitOf, rawZip } from './registry.js'

export const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// `git archive --prefix=acme-acme-ef76ec6/ <tree> | gzip -9n` of a repo of
// LICENSE, README.md, `foo.`, run.sh and Sources/Core/Exec.c executable,
// docs/guide.md, Acme.modulemap, Sources/Core/Acme.{h,m,swift},
// Sources/Cor, Sources/UI/View.swift, Resources/icon.png,
// Tests/AcmeTests.m and `link` to README.md; at a commit of that tree.
export const ACME = {
  commit: commitOf('ef76ec62379a5c7fb0002b7703afe955dfc7d764').id,
  tree: 'ef76ec62379a5c7fb0002b7703afe955dfc7d764',
  tarball: Buffer.from('H4sIAAAAAAACA+2bXWvbMBiFc71f4XU328VsS7ali41ByTIIW3extmO3rq00orEV/LEUyv77bAeyYHdJk8ryRs4JxM4HhHB4jvS+ksIoEW/D+knMOBMRc0ba5VbiPGiuldrX5p4ElBOPU+6z6n3iuz4fBSMDKvMizKqfzJQqdn1v3+ftP/efKOz4f169sBMVlwuRhEtd/jPm/91/j7T9Z4x4Ixf+965ZFiZipbI7a225VdtvPfx6MYJOQV3+v0zHk6+XE835v5N/12/zH7j1Ffz3rovpFVAH/1v8f5ucf7yY2ElskH/e4d+jGP9N6FUz4CMCwP+Gf5GrMotE7ujk/8D6j7mUoP4b2H8ZqdReprcDzP+4HxDkvwFV9iL8kf9b/F9qTv+j8j/wOUX+D+r/WGXDzf8Z8QLkv4n8z8RM3mMIQP4/wr9wtPF/6PzfY8j/f8D/ZjFo3nf++7Qz//e4j/w30f+RyVJlhfX+kyrTOCykSp0/t/b8A4aGU87/9WJw3/xT8gj/WP8xyf/ZOunPgDv4b/Ofr+Ss6JX/dv+Pup6L/p+R+q+8WcjIEmmZYOsH+G/zP7kXkR31Xf95Qbf/j/1fRiTTwqrtf/1TyfiN9WBloiiz1CLvLATBSfN/PdW1BHDU+q+L/b+D+/9ditWzZ39PmP+Rbv5zjvw3kv/r8u96+lkWyHvkP3OuRF7kWk+BHLP+Wz2Q/wP6X9eCzd2zu39POf/R7f9TQpH/BrTp//8Y13Y76wv6/qeb/7GK9Mb/Uef/qgkg8n84/29LGQtdZwD27/9hnfrPR/4bUWM0sh75v+F/ppSt9zeO2P/tM4r9fyYUK5T94H+b/4VM7/TzX8/nDun/UpeMqP6jiOB/r/9Zmdr5XL//O+b/pFP/B9RF/9dI/f/SuZGpk88xCkAQBEEQBJ2EfgNMvwi+AFAAAA==', 'base64'),
}

// The podspec of that repo, as trunk would serve it: Core and UI, Core by
// default, and a test spec; the source by the commit unless `source` says.
export function podspecOf({ source = { git: 'https://github.com/acme/acme.git', commit: ACME.commit }, ...rest } = {}) {
  return Buffer.from(`${JSON.stringify({
    name: 'Acme',
    version: '1.2.0',
    summary: 'A fixture',
    license: { type: 'MIT', file: 'LICENSE' },
    source,
    platforms: { ios: '13.0' },
    module_map: 'Acme.modulemap',
    default_subspecs: 'Core',
    subspecs: [
      { name: 'Core', source_files: 'Sources/Core' },
      { name: 'UI', source_files: 'Sources/UI/**/*.swift', resources: 'Resources/*.png', dependencies: { 'Acme/Core': [] } },
    ],
    testspecs: [{ name: 'Tests', test_type: 'unit', source_files: 'Tests/**/*.m' }],
    ...rest,
  }, null, 2)}\n`)
}

export const PODSPEC = podspecOf()
export const PODFILE = "platform :ios, '13.0'\ntarget 'App' do\n  pod 'Acme/Core'\nend\n"

// As CocoaPods writes the lockfile of PODFILE.
export const coreLock = (podspec = PODSPEC, podfile = PODFILE) => `PODS:\n  - Acme/Core (1.2.0)\n\nDEPENDENCIES:\n  - Acme/Core\n\nSPEC REPOS:\n  trunk:\n    - Acme\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(podspec)}\n\nPODFILE CHECKSUM: ${sha1(podfile)}\n\nCOCOAPODS: 1.16.2\n`

// GitHub's archive of the tag, which is the tarball of its tree above; and
// a podspec of Acme by :http, held to its sha256 unless `source` says.
export const ACME_ARCHIVE = 'https://github.com/acme/acme/archive/refs/tags/v1.2.0.tar.gz'
export const httpPodspecOf = (source = {}, rest = {}) => podspecOf({ source: { http: ACME_ARCHIVE, sha256: sha256(ACME.tarball), ...source }, ...rest })

// GitHub's zip of the tag, as `git archive --format=zip` writes one of that
// tree: a plain file or a directory by its MS-DOS attributes alone, an
// executable or a symlink by its Unix mode, each file deflated.
export const ACME_ZIP = 'https://github.com/acme/acme/archive/refs/tags/v1.2.0.zip'
export async function acmeZip() {
  return rawZip(unpack(await decompress(ACME.tarball, 'gzip')).map((entry) => {
    if (entry.type === 'directory') return { name: `${entry.name}/`, system: 0, attributes: 0x10 }
    if (entry.type === 'symlink') return { name: entry.name, data: entry.linkname, system: 3, attributes: 0o120777 * 0x10000 }
    const unix = (entry.mode & 0o111) !== 0
    return { name: entry.name, data: entry.data, system: unix ? 3 : 0, attributes: unix ? 0o100755 * 0x10000 : 0, deflate: entry.data.length > 0 }
  }))
}

// Acme/Core by :podspec, as CocoaPods writes the lockfile of a Podfile that
// asks for it so, `podspec` the JSON it wrote under Pods/Local Podspecs;
// with `checkout`, the commit it resolved its podspec's source to.
export const podspecLock = (podspec, checkout) => `PODS:\n  - Acme/Core (1.2.0)\n\nDEPENDENCIES:\n  - Acme/Core (from \`./Acme.podspec\`)\n\nEXTERNAL SOURCES:\n  Acme:\n    :podspec: "./Acme.podspec"\n\n${checkout === undefined ? '' : `CHECKOUT OPTIONS:\n  Acme:\n    :commit: ${checkout}\n    :git: https://github.com/acme/acme.git\n\n`}SPEC CHECKSUMS:\n  Acme: ${sha1(podspec)}\n\nCOCOAPODS: 1.16.2\n`

// Acme/Core; Local by :git, an external source deptree does not download;
// and Other from trunk, by :http, a source it does not download either.
// With `podfile`, the lockfile of that Podfile.
export const OTHER = Buffer.from(`${JSON.stringify({ name: 'Other', version: '1.0.0', source: { http: 'https://example.com/other.zip' } })}\n`)
export const MIXED_PODFILE = "platform :ios, '13.0'\ntarget 'App' do\n  pod 'Acme/Core'\n  pod 'Local', :git => 'https://github.com/acme/local.git'\n  pod 'Other'\nend\n"
export const mixedLock = (podfile) => `PODS:\n  - Acme/Core (1.2.0)\n  - Local (0.1.0)\n  - Other (1.0.0)\n\nDEPENDENCIES:\n  - Acme/Core\n  - Local (from \`https://github.com/acme/local.git\`)\n  - Other\n\nSPEC REPOS:\n  trunk:\n    - Acme\n    - Other\n\nEXTERNAL SOURCES:\n  Local:\n    :git: https://github.com/acme/local.git\n\nCHECKOUT OPTIONS:\n  Local:\n    :commit: ${'b'.repeat(40)}\n    :git: https://github.com/acme/local.git\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(PODSPEC)}\n  Local: ${'f'.repeat(40)}\n  Other: ${sha1(OTHER)}\n\n${podfile === undefined ? '' : `PODFILE CHECKSUM: ${sha1(podfile)}\n\n`}COCOAPODS: 1.16.2\n`

// Acme, Acme/UI and a pod by :path.
export const allLock = (podspec = PODSPEC) => `PODS:\n  - Acme (1.2.0):\n    - Acme/Core (= 1.2.0)\n  - Acme/Core (1.2.0)\n  - Acme/UI (1.2.0):\n    - Acme/Core\n  - Local (0.1.0)\n\nDEPENDENCIES:\n  - Acme\n  - Acme/UI\n  - Local (from \`../Local\`)\n\nSPEC REPOS:\n  trunk:\n    - Acme\n\nEXTERNAL SOURCES:\n  Local:\n    :path: "../Local"\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(podspec)}\n  Local: ${'f'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`
