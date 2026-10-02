import { Buffer } from 'node:buffer'

// Made by `git archive --prefix=acme-app-<short>/ <commit> | gzip -9n`.
// EXPORTED: a commit whose .gitattributes mark export-ignore /tests,
// /.gitattributes itself, /docs/notes.md, the one file in docs, so that
// docs is written empty, and *.dist; and src/.gitattributes, which the
// archive keeps, src/secret.txt. SUBST: the same, and version.txt, marked
// export-subst, which the archive rewrites with the commit.
export const EXPORTED_COMMIT = '6e456ae9b86421860210a953fb0f2fb7bf62f92f'
export const EXPORTED = '4a6d9acdb38100dcdfcdef3d4059bb5b85498049'
export const EXPORTED_TGZ = Buffer.from('H4sIAAAAAAACA+3Y3WqDMAAFYK/3FB27VvNvCxt7lJLYaIXWSIzg4y8ru3Jrd2OVdee7iRhB5HAStdPjvj45o0/7o9UH65P5kUgpdRmj6RgnRUIlZZJzIS7nqZCkSOpkAUMftI+39M6FW9f9Nj99uD9Csk3pzmfbhjdlhVTa7sxWCUa3ijBK9E7yypCKVaYwlWLVjlVPCTwMXZ5tqrsu/Uo/v1P/i0Je7388nvSfK8oTif4vn//BlX2+ev5CCuS/Sv5+aBfvP2Xf8uc8vi8g/7t7ec5N0+b9Ebs69v/P/ve+zJfu/w/rvyAM6/9a+Wd1E3QIvjFDsP1M33/iev6cTvMvmCqw/i+gt6W3IQtj2Nixcz6kTd06b7Ed/OP1X2fdsZv7/8+N/hM17b/kDP1fwut7jBplBwAAAAAAAAAAeEgf1U4yYQAoAAA=', 'base64')
export const SUBST_COMMIT = '68b4ac42e53b170e6eddb52632dd428ebdbbeeef'
export const SUBST = '8463c126f5643a2f5b53ff28641ab3f635e9cfdd'
export const SUBST_TGZ = Buffer.from('H4sIAAAAAAACA+2Yy27CMBBFs+5XUHUNSfwKi1b9FGTH0xCpxJFtEJ9fg9pNWugGjErv2diKLVnR1ZmRPer9qnt3Rr+v1qQt+eLyVAml1HFMTMe0KIpa1kyqSrLj91rIShVdkYFtiNqnI71z8dy+39anP/dHkGzWus2GhviilkboVjCS3NRNRYqsNZIpzqwVbEnGGkNEbw8FuBt0u6G5Hsf5Z/rllfxvGnna/zSf+M9V8l/C//z5W9eG8ub5C8mR/03y99shu/81+5Y/53VRIf+r8/RYmn4owxpdHf3/4H/wbZnb/x/qP0/7Uf9vlP+i66OO0fdmGylc6P4nTuefav0k/4YphvqfgUCtp7iI+zij/eh8nPfd4DyhHfzj+q8X43q89PvPGf/TXW/iv+QM/ufg+TVFDdnh/5f/O/Khd8OhI2TzX/Kp/6ri8D8HuxmefQEAAAAAAAAAgHvnAzu1ub0AKAAA', 'base64')
// GitHub's listings, as `git ls-tree -l` gives them, and the blobs of
// the top .gitattributes, which the archives leave out.
export const EXPORTED_LISTINGS = {
  '4a6d9acdb38100dcdfcdef3d4059bb5b85498049': [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: 'fde205cf5791114e567d38892489a81a0039188a', size: 101 },
    { path: 'docs', mode: '040000', type: 'tree', sha: 'd184003c45e7e16dffd8be2c94ba48f842a945d8' },
    { path: 'phpunit.xml.dist', mode: '100644', type: 'blob', sha: '01be07b1a2b5a49f1a683a529b1becd02ffb78a3', size: 11 },
    { path: 'run', mode: '100755', type: 'blob', sha: '1a2485251c33a70432394c93fb89330ef214bfc9', size: 10 },
    { path: 'src', mode: '040000', type: 'tree', sha: 'd38020b6559d20f8b70255b55ff42a980d9cb01b' },
    { path: 'tests', mode: '040000', type: 'tree', sha: '6542e451c861a026ed69b4130fd3aa96d61e5c04' },
  ],
  'd38020b6559d20f8b70255b55ff42a980d9cb01b': [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: '5087cf904075c893117567bbe8fd49c76ffa5a87', size: 25 },
    { path: 'a.php', mode: '100644', type: 'blob', sha: 'b3d9bbc7f3711e882119cd6b3af051245d859d04', size: 6 },
    { path: 'secret.txt', mode: '100644', type: 'blob', sha: 'd97c5eada5d8c52079031eef0107a4430a9617c5', size: 7 },
  ],
  'd184003c45e7e16dffd8be2c94ba48f842a945d8': [
    { path: 'notes.md', mode: '100644', type: 'blob', sha: 'bfa655111293037a5564088d1a9bbca4cbcf446b', size: 6 },
  ],
  '8463c126f5643a2f5b53ff28641ab3f635e9cfdd': [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: '25cb73d441ec89b9c966fb32a03a590909a83048', size: 127 },
    { path: 'docs', mode: '040000', type: 'tree', sha: 'd184003c45e7e16dffd8be2c94ba48f842a945d8' },
    { path: 'phpunit.xml.dist', mode: '100644', type: 'blob', sha: '01be07b1a2b5a49f1a683a529b1becd02ffb78a3', size: 11 },
    { path: 'run', mode: '100755', type: 'blob', sha: '1a2485251c33a70432394c93fb89330ef214bfc9', size: 10 },
    { path: 'src', mode: '040000', type: 'tree', sha: 'd38020b6559d20f8b70255b55ff42a980d9cb01b' },
    { path: 'tests', mode: '040000', type: 'tree', sha: '6542e451c861a026ed69b4130fd3aa96d61e5c04' },
    { path: 'version.txt', mode: '100644', type: 'blob', sha: 'e085b3d9b7f56abb56f664f66fd860695744e54f', size: 14 },
  ],
}
export const EXPORTED_BLOBS = {
  'fde205cf5791114e567d38892489a81a0039188a': '/tests export-ignore\n/.gitattributes export-ignore\n/docs/notes.md export-ignore\n*.dist export-ignore\n',
  '25cb73d441ec89b9c966fb32a03a590909a83048': '/tests export-ignore\n/.gitattributes export-ignore\n/docs/notes.md export-ignore\n*.dist export-ignore\n/version.txt export-subst\n',
}
// EOL: a.txt, marked text eol=crlf, which the archive writes with CRLF
// line ends, and its blob, with LF ones.
export const EOL_COMMIT = '654cce1721e39ce6c330c1397fba9766f80485df'
export const EOL = '3410b73c891e4ceb50af77e06e6c95a05ad85ad7'
export const EOL_TGZ = Buffer.from('H4sIAAAAAAACA+3WzYrCMBQF4KwF38H1gE7SJDd24bNIGtOO0E5KvYKPP5mfVUVnYwvjnG/RlKQQys25pPeXfdOmyrf7t+gPcRCPJzMi+hqz8ZgXjVBWFSQtfc8rY6UVjZjB+cR+yFsOKfG9735bH//cH2GLVUhdF995R9aEEJUrVNRliBS0lkHp0tWVLx1RvZVmaw/1QsDT8KGLa9/365/qv06Uf+fs7fzn91H+NUkjLPI/f/03zZE983CszhxPD+z/5nb9i6v+T8ZpIVH/yb1s+MIrjvkRU7sLQ4v+/q/7v/88EFPc/+7kX9L1/Y8U8j9H/ZeLaonEAwAAAAAAAAAAAAAAADyFDzbp7J4AKAAA', 'base64')
export const EOL_LISTING = [
  { path: '.gitattributes', mode: '100644', type: 'blob', sha: 'c61b241eb497eb431df825841e808503145600e1', size: 20 },
  { path: 'a.txt', mode: '100644', type: 'blob', sha: '422c2b7ab3b3c668038da977e4e93a5fc623169c', size: 4 },
]
export const EOL_BLOB = ['422c2b7ab3b3c668038da977e4e93a5fc623169c', 'a\nb\n']
// LINK: l, a link to a.txt, both of * text eol=crlf, which git writes a
// file's line ends by and never a link's.
export const LINK_COMMIT = '9ca7732198d15713269c108f24cdda423b9b1c67'
export const LINK = '64b1d34af54b41e55b337d858034be4337cc8852'
export const LINK_TGZ = Buffer.from('H4sIAAAAAAACA+3WzWqDQBQF4FkX+g6uC0m98xsXeZYwjhMb0CrmBnz8DCGLIk1KIQpNz7cZUUHkcC639+OubrrSN7uP6Ks4iMfLE2vt5UymZ3qoBRmSVklrL/dJG1KiFgs4HdkP6ZND1/G99356Pv25P8LILHRtGz95WwTvnJJUbCoyjlIYRaB8s5c6VJXXUpVFScG6FwFPw4c2rnzfr67pv8/Uf+fM7f6n60n/lVFOGPR/+fzX9YE983AoTxyPD5z/+nb+kqb52zRuRI78Z/eWcRw5i12zDUOzf8Vw/+fz36955Dn2vzv9z9U3+x+h/0vkj8aj/1/738y1/7nf7H/aOhJyhlmE/gMAAAAAAAAAAAAAwLM7A+aHHeMAKAAA', 'base64')
export const LINK_LISTING = [
  { path: '.gitattributes', mode: '100644', type: 'blob', sha: '92be83e26d2715c1f096e9e9d666ff9a67837a81' },
  { path: 'a.txt', mode: '100644', type: 'blob', sha: '78981922613b2afb6025042ff6bd878ac1994e85' },
  { path: 'l', mode: '120000', type: 'blob', sha: '8d14cbf983b3fad683171c9418998d9f68340823' },
]
