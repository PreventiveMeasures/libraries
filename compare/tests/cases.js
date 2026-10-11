// Pairs of trees, each made to turn on one thing git decides, for
// scripts/record-git.js to ask git about and for the tests to hold compare
// to what it said. Trees are as tests/git.js takes them.
//
// Lines of one length make the scores easy to read off: twenty lines of
// twenty bytes are 400 bytes, and each line kept is 5% of a file that size.

const lines = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}: line ${String(from + i).padStart(2, '0')} of text.\n`).join('')
const L = (from, to) => lines('L', from, to)
const M = (from, to) => lines('M', from, to)
const N = (from, to) => lines('N', from, to)

const CODE = [
  '#include <stdio.h>', '', 'int first(void)', '{', '\treturn 1;', '}', '',
  'static int a_function_whose_name_runs_on_past_the_eighty_bytes_git_keeps_of_one(int x)',
  '{', '\tint a = 1;', '\tint b = 2;', '\tint c = 3;', '\tint d = 4;', '\tint e = 5;', '\tint f = 6;', '\tint g = 7;',
  '\tint h = 8;', '\tint i = 9;', '\tint j = 10;', '\tint k = 11;', '\treturn a + b + c + d + e + f + g + h + i + j + k + x;', '}', '',
].join('\n')

export const CASES = [
  {
    name: 'every status, and the headers each gets',
    old: {
      'README': 'hello\n', 'gone.txt': 'bye\n', 'run.sh': 'echo hi\n', 'docs/guide.md': L(1, 20),
      'link': { link: 'README' }, 'typ': 'x\n', 'empty': '', 'bin.dat': { data: Uint8Array.of(0, 1, 2, 3, 4) },
    },
    new: {
      'README': 'hello\nworld\n', 'run.sh': { data: 'echo hi\n', mode: 0o755 }, 'manual/guide.md': L(1, 18) + N(1, 2),
      'link': { link: 'run.sh' }, 'typ': { link: 'README' }, 'empty2': '', 'bin.dat': { data: Uint8Array.of(0, 1, 2, 3, 5) }, 'added.txt': 'new\n',
    },
  },
  {
    name: 'a mode changes along with a rename',
    old: { 'bin/tool': { data: L(1, 20) }, 'same.sh': { data: 'true\n' } },
    new: { 'tools/tool': { data: L(1, 19) + N(1, 1), mode: 0o755 }, 'moved.sh': { data: 'true\n', mode: 0o755 } },
  },
  {
    name: 'an identical file of the same basename is taken first, then the first in path order',
    old: { 'a/x.txt': L(1, 5), 'b/y.txt': L(1, 5), 'c/y.txt': L(1, 5) },
    new: { 'd/y.txt': L(1, 5), 'e/z.txt': L(1, 5) },
  },
  {
    name: 'identical files are paired in path order, and one left over is deleted',
    old: { '1.txt': L(1, 3), '2.txt': L(1, 3), '3.txt': L(1, 3), 'empty-a': '', 'empty-b': '' },
    new: { 'a.txt': L(1, 3), 'b.txt': L(1, 3), 'empty-c': '' },
  },
  {
    name: 'a link is renamed only unchanged, and never to or from a file',
    old: { 'l1': { link: 'target' }, 'l2': { link: 'other' }, 'f': 'pointer' },
    new: { 'm1': { link: 'target' }, 'm2': { link: 'others' }, 'g': { link: 'pointer' } },
  },
  {
    name: 'a basename alone on both sides pairs at 75%, before a better match is scored',
    old: { 'old/name.txt': L(1, 20) },
    new: { 'new/name.txt': L(1, 16) + N(1, 4), 'new/other.txt': L(1, 19) + N(5, 5) },
  },
  {
    name: 'a basename alone on both sides below 75% is left to the scores',
    old: { 'old/name.txt': L(1, 20) },
    new: { 'new/name.txt': L(1, 14) + N(1, 6), 'new/other.txt': L(1, 19) + N(7, 7) },
  },
  {
    name: 'among equal scores a shared basename wins, then path order',
    old: { 'a/g.txt': L(1, 16) + M(1, 4), 'p/f.txt': L(1, 16) + M(5, 8), 'q/f.txt': L(1, 16) + M(9, 12) },
    new: { 'r/f.txt': L(1, 16) + N(1, 4) },
  },
  {
    name: 'the best pair is taken first, and its source is not taken again',
    old: { 'a.txt': L(1, 20), 'b.txt': M(1, 20) },
    new: { 'x.txt': L(1, 12) + M(1, 8), 'y.txt': L(1, 18) + N(1, 2) },
  },
  {
    name: 'sizes too far apart are never scored',
    old: { 'big.txt': L(1, 20) },
    new: { 'small.txt': L(1, 9) },
  },
  {
    name: 'CRLF is passed over in what was copied, not in the size',
    old: { 'unix.txt': L(1, 20) },
    new: { 'dos.txt': L(1, 20).replaceAll('\n', '\r\n') },
  },
  {
    // 300 bytes of 320 copied; before git 2.44, the 36 at the end were not
    // counted on either side, and this was 82%.
    name: 'the last span counts without a newline after it',
    old: { 'tail.txt': L(1, 10) + 'T'.repeat(100) },
    new: { 'tail2.txt': N(1, 1) + L(1, 10) + 'T'.repeat(100) },
  },
  {
    name: 'lines past 64 bytes are cut into spans',
    old: { 'wide.txt': `${'w'.repeat(200)}\n${'v'.repeat(100)}\n` },
    new: { 'wider.txt': `${'w'.repeat(200)}\n${'v'.repeat(99)}V\n` },
  },
  {
    name: 'a binary file renamed and changed',
    old: { 'img.bin': { data: Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256) } },
    new: { 'pic.bin': { data: Uint8Array.from({ length: 300 }, (_, i) => (i === 299 ? 1 : (i * 7) % 256)) } },
  },
  {
    name: 'a file whose path becomes a directory',
    old: { 'x': 'same\n', 'y/z': 'deep\n' },
    new: { 'x/y': 'same\n', 'y': 'deep\n' },
  },
  {
    name: 'names git quotes, and a tab after a label with a space',
    old: { 'with space.txt': 'a\n', 'tab\tname': 'b\n', 'quote"name': 'c\n', 'back\\slash': 'd\n', '\u{E9}t\u{E9}.txt': 'e\n', 'new\nline': 'f\n', 'moved here': L(1, 20) },
    new: { 'with space.txt': 'A\n', 'tab\tname': 'B\n', 'quote"name': 'C\n', 'back\\slash': 'D\n', '\u{E9}t\u{E9}.txt': 'E\n', 'new\nline': 'F\n', 'moved there': L(1, 19) + N(1, 1) },
  },
  {
    name: 'hunks named by the function above them, cut to 80 bytes',
    old: { 'code.c': CODE },
    new: { 'code.c': CODE.replace('int c = 3;', 'int c = 33;').replace('int j = 10;', 'int j = 100;').replace('return 1;', 'return 0;') },
  },
  {
    name: 'no newline at the end of a file, before and after',
    old: { 'a.txt': 'one\ntwo', 'b.txt': 'one\ntwo\n' },
    new: { 'a.txt': 'one\ntwo\n', 'b.txt': 'one\ntwo' },
  },
  {
    name: 'renames off',
    options: { renames: false },
    old: { 'a/x.txt': L(1, 5), 'old.txt': L(1, 20) },
    new: { 'b/x.txt': L(1, 5), 'new.txt': L(1, 19) + N(1, 1) },
  },
  {
    name: 'renames at 100% alone',
    options: { renames: 100 },
    old: { 'a/x.txt': L(1, 5), 'old.txt': L(1, 20) },
    new: { 'b/x.txt': L(1, 5), 'new.txt': L(1, 19) + N(1, 1) },
  },
  {
    name: 'renames at 90%',
    options: { renames: 90 },
    old: { 'a.txt': L(1, 20), 'b.txt': M(1, 20) },
    new: { 'c.txt': L(1, 19) + N(1, 1), 'd.txt': M(1, 17) + N(2, 4) },
  },
  {
    name: 'a rename limit too low for the scores, and not for identical files or basenames',
    options: { renameLimit: 1 },
    old: { 'a.txt': L(1, 20), 'b.txt': M(1, 20), 'same.txt': N(1, 3), 'p/base.txt': N(4, 20) },
    new: { 'c.txt': L(1, 19) + N(1, 1), 'd.txt': M(1, 19) + N(2, 2), 'also-same.txt': N(1, 3), 'q/base.txt': N(4, 19) + M(1, 1) },
  },
]
