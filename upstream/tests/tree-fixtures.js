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
// GitHub's listings of TREE, its `lib` (TREE_LIB), SUBMODULE, CRLF and
// CRLF_ANDROID, as `git ls-tree -l` gives them: { path, mode, type, sha },
// and a size for a blob.
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
