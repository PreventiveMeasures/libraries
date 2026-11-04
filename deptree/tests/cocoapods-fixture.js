// The fixture the CocoaPods tests share: a repo's tarball as GitHub serves
// it, its podspec as trunk would, and lockfiles as CocoaPods writes them.
import { createHash } from 'node:crypto'

export const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

// `git archive --prefix=acme-acme-ef76ec6/ <tree> | gzip -9n` of a repo of
// LICENSE, README.md, `foo.`, run.sh and Sources/Core/Exec.c executable,
// docs/guide.md, Acme.modulemap, Sources/Core/Acme.{h,m,swift},
// Sources/Cor, Sources/UI/View.swift, Resources/icon.png,
// Tests/AcmeTests.m and `link` to README.md; at a commit of that tree.
export const ACME = {
  commit: '7f3c0d1e9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c3d',
  tree: 'ef76ec62379a5c7fb0002b7703afe955dfc7d764',
  tarball: Buffer.from('H4sIAAAAAAACA+2bXWvbMBiFc71f4XU328VsS7ali41ByTIIW3extmO3rq00orEV/LEUyv77bAeyYHdJk8ryRs4JxM4HhHB4jvS+ksIoEW/D+knMOBMRc0ba5VbiPGiuldrX5p4ElBOPU+6z6n3iuz4fBSMDKvMizKqfzJQqdn1v3+ftP/efKOz4f169sBMVlwuRhEtd/jPm/91/j7T9Z4x4Ixf+965ZFiZipbI7a225VdtvPfx6MYJOQV3+v0zHk6+XE835v5N/12/zH7j1Ffz3rovpFVAH/1v8f5ucf7yY2ElskH/e4d+jGP9N6FUz4CMCwP+Gf5GrMotE7ujk/8D6j7mUoP4b2H8ZqdReprcDzP+4HxDkvwFV9iL8kf9b/F9qTv+j8j/wOUX+D+r/WGXDzf8Z8QLkv4n8z8RM3mMIQP4/wr9wtPF/6PzfY8j/f8D/ZjFo3nf++7Qz//e4j/w30f+RyVJlhfX+kyrTOCykSp0/t/b8A4aGU87/9WJw3/xT8gj/WP8xyf/ZOunPgDv4b/Ofr+Ss6JX/dv+Pup6L/p+R+q+8WcjIEmmZYOsH+G/zP7kXkR31Xf95Qbf/j/1fRiTTwqrtf/1TyfiN9WBloiiz1CLvLATBSfN/PdW1BHDU+q+L/b+D+/9ditWzZ39PmP+Rbv5zjvw3kv/r8u96+lkWyHvkP3OuRF7kWk+BHLP+Wz2Q/wP6X9eCzd2zu39POf/R7f9TQpH/BrTp//8Y13Y76wv6/qeb/7GK9Mb/Uef/qgkg8n84/29LGQtdZwD27/9hnfrPR/4bUWM0sh75v+F/ppSt9zeO2P/tM4r9fyYUK5T94H+b/4VM7/TzX8/nDun/UpeMqP6jiOB/r/9Zmdr5XL//O+b/pFP/B9RF/9dI/f/SuZGpk88xCkAQBEEQBJ2EfgNMvwi+AFAAAA==', 'base64'),
}

// The podspec of that repo, as trunk would serve it: Core and UI, Core by
// default, and a test spec; the source by `tag` unless `source` says.
export function podspecOf({ source = { git: 'https://github.com/acme/acme.git', tag: 'v1.2.0' }, ...rest } = {}) {
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

// Acme, Acme/UI and a pod by :path.
export const allLock = (podspec = PODSPEC) => `PODS:\n  - Acme (1.2.0):\n    - Acme/Core (= 1.2.0)\n  - Acme/Core (1.2.0)\n  - Acme/UI (1.2.0):\n    - Acme/Core\n  - Local (0.1.0)\n\nDEPENDENCIES:\n  - Acme\n  - Acme/UI\n  - Local (from \`../Local\`)\n\nSPEC REPOS:\n  trunk:\n    - Acme\n\nEXTERNAL SOURCES:\n  Local:\n    :path: "../Local"\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(podspec)}\n  Local: ${'f'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`
