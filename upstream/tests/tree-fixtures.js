import { Buffer } from 'node:buffer'

// Made by `git archive --prefix=acme-app-abc1234/ <tree> | gzip -9n`. TREE:
// an executable, symlinks with short and long targets, a path over 255
// bytes, a non-ASCII name, and `a-b`, `a.b` and `a/` side by side, which
// git sorts with a `/` after a directory's name. SUBMODULE: the same, and
// a submodule, `sub` at SUBMODULE_COMMIT. COMMIT: TREE's commit, with git's
// global header naming it.
export const TREE = '1931efbe24f8fa66c420dea924166a279ca3f3a7'
export const SUBMODULE = '08e030b01c9c789f8e7e6570a3e40948b6f27ea7'
export const SUBMODULE_COMMIT = 'f7d16464b1328679020181c9e3e873c38a95466b'
export const TREE_TGZ = Buffer.from('H4sIAAAAAAACA+2a346aQBjFue5T2PRamZlv/sBFH2YYhmh3qwTZhKTpQ/UZ+mId3KuF1C1bGNz1/GKCARM1J+d850Ot++63tq63tnBckEyT+WEBY9TlGBgeL8+5EspIJg2T4TwnzXSikgg8nVvbhLdsTqf22uteuz78cu8EO9Tfbosl9NdaXtFfDPWXXIfr0H9x+KcE3DFj/+9uxP8c/o+AgP/h/xf+n78BvqH/SSbQ/1bS391G/hPyPwKE/L9rykoKLT3l3hS+ZESlIWtz0s6Q6D3pdelyVexq2+29LX3zVv/rv/pf8KH/BVNESQf/L7//Ubapbbv/OhoEZVRS5NBt+7+0rY3X/wwZif4XAZUF3XUhHVV5/3Ayyx3jnBeFVSrXXBortFs0/6Ua539/DvkfYf/PbyT//Y3zQefTP/v/P/N/4v5nhDHY/yLQoXfdNRTGb3Cnk86UpspUlglmKhJGCRmKH3HmjWJZFXv/YxrzP9b+93g4Plw6wOOhSLuVQA6twqj2VbaZ+z2e9z8zYf8TZARLxNn7zdIBhfv/L/XvM2AR/af9/kMK+/9q+tvdt/PM+l/t/6P5z1X4LOj/EfBdfWrazY+fmL+Y/8/+Pz6sPv+5ZkwlYoEsgv9f0b95Oi7T/9SU/JdE+P9XDL58TovDMT3vkf/I/97/v3/t2q6d3f8T7/8qEc7B/xG+PnwPAAAAAAAAAAAAAAAAAAAAAAAfgj+Oj7D2AFAAAA==', 'base64')
export const SUBMODULE_TGZ = Buffer.from('H4sIAAAAAAACA+2azW7aQBSFvQ1PQdO18fyPvciTVF3MjMeFhh/LP5Klqg/VZ+iLdSCrgEJKigc3OZ+QPBhLxjqcc++1MW7jU1PXqbGOMi6y5PqQgNbysA0cbw9rKpnUgghNRNhPuSIqkUkE+rYzTThls9t154577fPji/tPMMf6L76tus2u7Ne+vab+SokX9adaHesvtdIJgf6j86Xt7ZPc8/uwvP86u6tNt5w/zMO72V3frMMy6zZ15tamL31KsnS5C7+ZvvVNul7ZxjQr32ZcMeGkUqnLC5vK3MjUSs5SbY2luWK5rEzWusZ0blmbMqsGljWzBEzN/ya1Y+T/Of8Two79L6gi8H8EKDwI/z/z/2Ii/qfwfwQY/A//P/P/9SfAN8x/gjDMfzfS300j/znyPwIc+f+hKSvBlPC88Nr6knBeam5MwZXTnO096VXpCmkXtRmW3pS+eav/1Yv+Z/TY/4xIzpMB/h9//uP5fH/D5+GkEJRRyZBD0/Z/aToTr//TXAv0fxGQedBdWeF4VexfTuSFI5RSa42UhaJCG6bcqPkv5Gn+7/ch/yPM/8VE8t9PnHdan/7a//+Y/xfOf5ppPP+LwYC+60PDQ/kN7nTC6VJXucxzRnTFmZZMhMaPU+K1JHkVe/4jCvU/1vy3Xm0fDz3AemWz4UYgh27CSdtXmeba53ia//QF8x/jmpGEtd7Pxw4o3P9/rv8+A0bR/7LnP1xi/r+Z/mbxvb2y/mf7/5P6T2X4Luj/I+CHetd08x8/UX9R/5/8v328ef2nihCZsBGyCP5/Rf+m347T/8lL8l9wjv9/xeDzp8yutlm7RP4j//f+b/tp9P+hXqD/v4H+v38tuqG7uv4X3v+XLOxD/ke4fOQ+AAAAAAAAAAAAAAAAAPDu+APnjPc8AFAAAA==', 'base64')
export const COMMIT_TGZ = Buffer.from('H4sIAAAAAAACA+2a3Y7aMBCFc92noOo1YM/4J7nYZ1nZjrPQ5U+QlSJVfag+Q1+sZvcKUKFsiWHZ8wkpyEaCaHTOnDFZue7xabb0bvY4ia6O6+LyiIQx5vWa2L+mTVVITdoqoaxQaV0qTVQ8FRl42bRunb5yvVy2xz53an//5j4ImgZhOZ/HRfvQ2FoaZZSXTKWxlSAhSxmqyLG0HLh0lVbG+C8FuBtcmMehW62GzgdJrMY96d9a/Xf9p/d7+mcjTKGh//z1d0Pfj/+rI/WnA/+XJu2j/r0j4ebw/x39j25E/xL6zwBB/9D/jv4vnwDfkf+UIOS/K9U/3Ib/M/w/Awz//9TUjSKjIlfR+lgL5tqycxWbYJm2moymDpX2o5Xr3ntAeOr8j+S+/klo5qKD/vuf/7gcrFw7eThoBHVWxvCh29Z/7VqXL/9Ztgr5LwO6THU3XgVuqu0rqLIKQkrpvdO6MlJZRyb06v9KH/r/dg3+n2H+r27E/+ONc6f96Z/1/5/+f+b8Z8lazH8Z6JC7PjWc2m9SZ1DB1rYpdVmSsA2T1aRS8GMpotWibHLPf8Kg/+ea/2bTxfNrBphN/bi7EvChq3AQ+xp38UfA3uY/e8b8R2xJFLSJcdC3QeH8f7f+Ww/opf7n/f/DGvP/1ervRt83F67/0fx/0P+lTr8F+T8DsVst1+3gx0/0X/T/N/0vnq/e/6URQhfUgxdB/yfqv35Z9JP/9Dn+r5jx/FcOvn0d++livJnA/+H/W/3//jVqu/bi+j/z/FdTWoP+M9w+dA8AAAAAAAAAAAAAAAAAAHBX/AGduPxdAFAAAA==', 'base64')
// NESTED: `lib/a.js`, and a submodule at `lib/sub`, NESTED_COMMIT, in the
// tree NESTED_LIB.
export const NESTED = '874f3a1f1e72dc7705dc93544b98bc923a8bbfa9'
export const NESTED_LIB = '8804c58ad81297708f853c08b6c0060251ea8f2c'
export const NESTED_COMMIT = 'e962c7c6eabb10a32b4e9659c89fe5a82648a968'
export const NESTED_TGZ = Buffer.from('H4sIAAAAAAACA+3V3UrDMBwF8N5uT1F2H/PRJK0XPol48U/WuUlHS5LCQHx349SbipNB3RTO7yZNGijlNKfk9y2jYWDkvFSV5sX8RFbX5jhm0/F4LY0ytZZCK5vXZWWFLkxxAWNMFPIjQ9+nU/t+uj99uX+CpvnfPO7Svl+PXRvnzN9a/W3+Sthp/qY2dSGQ/6+7j6N7j7tcdTvH83T1sFwMlLblXfmxslyMoctTnvYD9x2N65YJzrZ9/nbG2AaW9wUKuzbyyirtjbXMN7eOmYYMc6ZSrHbkZGNVYzbEow+U/HagNd8cKh6WBfyV8/8W+fX7X1dGof+vlT/dPMWZ8z/V/0KqL/0vlUT/X0B7GPqQyucXdDD6//P8518+n/n8n9n/Jv8B0P8AAAAAAAAAAAAAAAAAZ3oFia/T3AAoAAA=', 'base64')
// EMPTIES: `f`, `d/g`, and subtrees with no file in them, which git
// archive leaves out: `empty` and `d/e`, the empty tree, and `n`,
// holding only `n/m`, the empty tree too.
export const EMPTIES = '7d53d19498b95277f1e306217f31dff5f7ea0882'
export const EMPTIES_D = '55b3cb71b68ba275eb66fc42c482f64559ff4288'
export const EMPTIES_N = 'c1920f2a78ad891ff74cdcf908747b48f7db546e'
export const EMPTIES_TGZ = Buffer.from('H4sIAAAAAAACA+3VSwrDIBSFYcfdS4jX53ps2mZUEtIUuvxKhgmkFGr6+r+JooLI4WBqzscq9X2V9o0Y62r1ejqL0U9jNh+nuXjjoxPjrcvrYoMOyqsNXC9jGvKVQ9eNa+ce7c8f9yXSPP9D/Qn5O22F/N+Tf1si/xDcSv5mkb9EozT5F9fuFP7Yov+nMv//k/230QX6v4Eb/QcAAAAAAAAAAACAn3AHHD/hkAAoAAA=', 'base64')
// CRLF: `.gitattributes` marking `*.bat text eol=crlf`, and `build.bat`
// and `android/gradlew.bat` committed with LF, which `git archive` writes
// with CRLF; `android/a.js`; `dos.txt`, committed with CRLF, as written.
// CRLF_ANDROID is its `android`.
export const CRLF = '5755b783322b1e0caa98bb3ac613c74840f9174b'
export const CRLF_ANDROID = '69327553b62c6f3abe6bd949f428ef981f26ff0f'
export const CRLF_TGZ = Buffer.from('H4sIAAAAAAACA+2W0WqDMBSGvRb6DoHdDWqNMfFq0Ls9wq5jjF2GbSQ5UmHs3WcdbENZy4Z1zJ3vJmIE0Z/vz5Fqr9eyrtcyVzRh6SaYnrgjy3i/dgzX/pryRMSCp0madfcpE5QGPJiBxoN03SudtXDuuUv7w4/7I8hh/tHOgARwJm9A+8nyFyL9Ov9slL/gMQ1izP/q3BBfa2VKo0hpHTmaQ2GPnnjlTA2kNJX24W2USyCgWyDaVnfKVWUYIItg5L88FM6aYspz4Af9zxOG/f+r+cvoyU+Y/9n+p8mo//t9zP/q6La2DsjzCzY69v9n/3dOFpU+no7+q/sv2ND/jKUc/Z+BrdN7ct9nTU5/Apr6ffjr5sGHt3lwFW61erTEluUKi2LR/ueNqYoprP+G/4kYzX8sE+j/HP5/eK1bA2STkxgV/8f+F9ZH0MKU77jofzz2nzKG/s+R/yrM0XcEQRAEQRAEQRAEQZDl8goaly4+ACgAAA==', 'base64')
// MIXED: a .gitattributes with `*.bat text eol=crlf`, `[attr]win text
// eol=crlf` for `*.cmd`, `*.txt text=auto eol=crlf`, `*.bin binary` and
// `docs/** eol=crlf`, and `sub/.gitattributes` with `*.bat -text`, over
// files all committed with LF. `git archive` wrote `a.bat`, `c.cmd`,
// `d.txt` and `docs/x.md` with CRLF, and as committed `sub/b.bat`,
// `e.txt` (a NUL), `h.txt` (a lone CR), `f.bin` and `g.js`. INJECTED: the
// same tree archived with `*.js eol=crlf` in .git/info/attributes, which no
// checkout of the tree has, so `g.js` with CRLF too.
export const MIXED = 'ca041eec32322df9e4fdf286bbd8640d06209b0b'
export const MIXED_SUB = 'e2bc20d59db3ad7ccc5ca99504c862364e51f125'
export const MIXED_DOCS = '63e18324d7a8da399104d642bba0ce3b5d598333'
export const MIXED_TGZ = Buffer.from('H4sIAAAAAAACA+2a0WqDMBSGvRZ8h8DuCq1RE70q7D3GLmIaN4ddiqbMMfbuS9rBmLIWiosd+z8oSpNW5PAdT44RcquWYrdbilImacbiYHqopSj44WgZHg/nCU9zmuecMTcvyfIkC3jggX1nRGsv2WptTs07Nz68uT+CGMZ/9VAbYUxbl3ujusnin+fsx/gnnA/jn3NaBBTx/3XuXKzvX+pnYlRviNLNWrZNFS5WpTCj7+R2Q+xce2b64+ha7I3+9jP7V/Yj2tdwo2UXLxZfowG4ev+FC/z0+f+U/zTNh/4znibw3wO3Sj5qoqsqClVfGxKXhEYQ9f/6L12S9+x/wsb+Jxz+e2ArZKujsFMG1sN/6//GlXZX4H+Rwn8f8bflexS6Sh7+w3/nv1u0zd7/YZyh/zNf/PvVlDXg+fw/Wv/xLMP6zwc3xAU8Cpv6WeEJgPwfq2up/zL476n+Cz77tbAB/seV6+Bfgf8p+j8++FS/qhsF/+E/ix9WT13g2/905H9WUPjvAdXvdGvI2zvsh//O/8c56n+K/u9MNNqu+2UL++H/0f9uX069B/CS/i+jDP3fueI/8R7AC9Z/RYr874XjPr+lewGIZwDy/9H/cto9gOf9z8bvf7D/10/9pyoTio7UHfQHAAAAAAAAAAAAAAAAAAAAAAAA/iofHmrp7ABQAAA=', 'base64')
export const INJECTED_TGZ = Buffer.from('H4sIAAAAAAACA+2a32rCMBSHe13oOwR2J2j/JGmvhL3H2EUa062jGmkj6xh79yU6GKtMQbpU2e8DaTGtIofv9JxjhFyrudhu56KUaUZZHIxPYikKvj9ahsf9ecqzPMlzzpi7LqV5SgMeeGDXGdHar2y1NqeuO7c+/HE3ghjGf/FUG2FMW5c7o7rR4p/n7Nf4p5wP45/zpAgSxP/PeXCxfnytN8So3hClm6VsmyqcLUphjt6T6xWx19oz0x9Wl2Jn9I/b7EfZl2jfwpWWXTybfa8G4Or9Fy7w4+f/U/4nWT70n/Eshf8euFfyWRNdVVGo+tqQuCRJBFH/r//SJXnP/qfs2P+Uw38PrIVsdRR2ysB6+G/9X7nS7gr8LzL47yP+tnyPQlfJw3/47/x3Tdvk8x/GGeY/08W/X4xZA57P/0f9H6cU/Z8P7ogLeBQ29UbhCYD8H6trqf8o/PdU/wVf81rYAP/jyk3wr8D/DPMfH3ypX9WNgv/wn8VPi5cu8O0/PfKfFqj/faD6rW4Nef9A8Q//nf/PU9T/Cea/E9Fo2/fLFvLD/4P/3a4cew/gJfNfljDMf6eK/8h7AC/o/4oM+d8Lh31+c/cHIJ4ByP8H/8tx9wBe0P9xiv2/fuo/VZlQdKTuoD8AAAAAAAAAAAAAAAAAAAAAAABwq3wC782BtwBQAAA=', 'base64')
// GitHub's listings of TREE, its `lib` (TREE_LIB), SUBMODULE, CRLF,
// CRLF_ANDROID, MIXED, MIXED_SUB and MIXED_DOCS, as `git ls-tree -l` gives
// them: { path, mode, type, sha }, and a size for a blob.
export const TREE_LIB = '5d216e498d6125ed6472ebafd65ee273f6f362d7'
export const LISTINGS = {
  [TREE]: [
    { path: 'a-b', mode: '100644', type: 'blob', sha: 'd00491fd7e5bb6fa28c517a0bb32b8b506539d4d', size: 2 },
    { path: 'a.b', mode: '100644', type: 'blob', sha: '0cfbf08886fca9a91cb753ec8734c84fcbe52c9f', size: 2 },
    { path: 'a', mode: '040000', type: 'tree', sha: 'b2f4425009094fc2bf650841d1150197a61c62fc' },
    { path: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', mode: '040000', type: 'tree', sha: 'df4264e39e7bed033d73aa936c7325257e6dc95b' },
    { path: 'far', mode: '120000', type: 'blob', sha: '3004006c4c7d7f8588207f327524dc9310e7508f', size: 124 },
    { path: 'lib', mode: '040000', type: 'tree', sha: '5d216e498d6125ed6472ebafd65ee273f6f362d7' },
    { path: 'link', mode: '120000', type: 'blob', sha: '9d64ed0490eaac97d2f2413e2dc299ee38d7a6cf', size: 8 },
    { path: 'run', mode: '100755', type: 'blob', sha: '1a2485251c33a70432394c93fb89330ef214bfc9', size: 10 },
    { path: 'ñ.txt', mode: '100644', type: 'blob', sha: '4ae8ef021bf6fcfff43a13be5abfa52bb6fb5dbc', size: 2 },
  ],
  [TREE_LIB]: [
    { path: 'a.js', mode: '100644', type: 'blob', sha: '336ce12bb9106afdf843063ee67c0c1970f70d37', size: 10 },
  ],
  [CRLF]: [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: '23ac65ee5cc5bd3e888ede3cdd701a319318893d', size: 56 },
    { path: 'android', mode: '040000', type: 'tree', sha: '69327553b62c6f3abe6bd949f428ef981f26ff0f' },
    { path: 'build.bat', mode: '100644', type: 'blob', sha: 'c639960482b112c962c82c9839eb1b0c791fd14e', size: 20 },
    { path: 'dos.txt', mode: '100644', type: 'blob', sha: 'c30dea8a3641ea99b125d04d599d843712292759', size: 6 },
  ],
  [CRLF_ANDROID]: [
    { path: 'a.js', mode: '100644', type: 'blob', sha: '336ce12bb9106afdf843063ee67c0c1970f70d37', size: 10 },
    { path: 'gradlew.bat', mode: '100644', type: 'blob', sha: '3442422191927c611b2dd56106d8b505df05e775', size: 49 },
  ],
  [MIXED]: [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: 'c70e0278909c3a664806bbb2ca1e640c2254c97d', size: 109 },
    { path: 'a.bat', mode: '100644', type: 'blob', sha: 'c639960482b112c962c82c9839eb1b0c791fd14e', size: 20 },
    { path: 'c.cmd', mode: '100644', type: 'blob', sha: '8b7ec2983058de5cb0ae186876c11408bb23174c', size: 10 },
    { path: 'd.txt', mode: '100644', type: 'blob', sha: 'e091cacecddd363113aa179ea7ac8850624e8ea2', size: 10 },
    { path: 'docs', mode: '040000', type: 'tree', sha: '63e18324d7a8da399104d642bba0ce3b5d598333' },
    { path: 'e.txt', mode: '100644', type: 'blob', sha: 'a5b6fbb80e81609f427a9d5189ffff1ca42629a1', size: 12 },
    { path: 'f.bin', mode: '100644', type: 'blob', sha: '63804f7a02faa9a04563c361040bf19378a0c3dd', size: 12 },
    { path: 'g.js', mode: '100644', type: 'blob', sha: '336ce12bb9106afdf843063ee67c0c1970f70d37', size: 10 },
    { path: 'h.txt', mode: '100644', type: 'blob', sha: '9982af127e81e3ff4420daea4a12fb2fc4af4a8c', size: 8 },
    { path: 'sub', mode: '040000', type: 'tree', sha: 'e2bc20d59db3ad7ccc5ca99504c862364e51f125' },
  ],
  [MIXED_SUB]: [
    { path: '.gitattributes', mode: '100644', type: 'blob', sha: '7eed146613769ef18cf120155500f18e5182c92c', size: 12 },
    { path: 'b.bat', mode: '100644', type: 'blob', sha: 'f80181c4cbeb747e0e3230f024e722cd2cda32b6', size: 11 },
  ],
  [MIXED_DOCS]: [
    { path: 'x.md', mode: '100644', type: 'blob', sha: 'b1bd6c0692e2fdf1ca6b3b39aa817443af4e9a58', size: 12 },
  ],
  [SUBMODULE]: [
    { path: '.gitmodules', mode: '100644', type: 'blob', sha: '454c1e4897c73f969927180de8349a69396de7d4', size: 126 },
    { path: 'a-b', mode: '100644', type: 'blob', sha: 'd00491fd7e5bb6fa28c517a0bb32b8b506539d4d', size: 2 },
    { path: 'a.b', mode: '100644', type: 'blob', sha: '0cfbf08886fca9a91cb753ec8734c84fcbe52c9f', size: 2 },
    { path: 'a', mode: '040000', type: 'tree', sha: 'b2f4425009094fc2bf650841d1150197a61c62fc' },
    { path: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', mode: '040000', type: 'tree', sha: 'df4264e39e7bed033d73aa936c7325257e6dc95b' },
    { path: 'far', mode: '120000', type: 'blob', sha: '3004006c4c7d7f8588207f327524dc9310e7508f', size: 124 },
    { path: 'lib', mode: '040000', type: 'tree', sha: '5d216e498d6125ed6472ebafd65ee273f6f362d7' },
    { path: 'link', mode: '120000', type: 'blob', sha: '9d64ed0490eaac97d2f2413e2dc299ee38d7a6cf', size: 8 },
    { path: 'run', mode: '100755', type: 'blob', sha: '1a2485251c33a70432394c93fb89330ef214bfc9', size: 10 },
    { path: 'sub', mode: '160000', type: 'commit', sha: 'f7d16464b1328679020181c9e3e873c38a95466b' },
    { path: 'ñ.txt', mode: '100644', type: 'blob', sha: '4ae8ef021bf6fcfff43a13be5abfa52bb6fb5dbc', size: 2 },
  ],
}
