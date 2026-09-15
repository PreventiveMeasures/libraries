// Output recorded from GNU diff 3.10 in the C locale, taken from the
// conformance corpus of @preventive/terminal, where it was recorded against
// a virtual filesystem that keeps no modification times — so a header
// carries the name alone, as it does under --label, and what GNU printed
// after the tab was dropped.
//
// Every case is two plain text files and one format flag, with no option
// that changes what is compared, so a recording turns on nothing but the
// change set GNU chose and how GNU rendered it. Which of several shortest
// change sets diff picks is its own, but every pair here has one shortest
// change set, so GNU's is the only shortest one: the change set is pinned
// as much as the bytes are.

// The files the recordings name, as the corpus tree holds them.
export const FILES = {
  a1: 'a\n',
  a2: 'a',
  app: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n',
  big: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
  big2: '1\n2\n3\n4\nNEW1\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\ntwenty\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
  blank1: 'a\n\n\nb\n',
  blank2: 'a\nb\n',
  cr1: 'a\r\nb\r\n',
  cr3: 'a\nb\n',
  del: 'a\nb\nd\ne\nf\ng\nh\ni\nj\n',
  empty: '',
  f1: 'int main() {\n  int a;\n  int b;\n  int c;\n  int d;\n  int e;\n  return 0;\n}\nvoid other() {\n  x;\n  y;\n  z;\n  w;\n  v;\n}\n',
  f2: 'int main() {\n  int a;\n  int b;\n  int c;\n  int d;\n  int E;\n  return 0;\n}\nvoid other() {\n  x;\n  y;\n  z;\n  W;\n  v;\n}\n',
  g1: 'function_with_a_very_long_name_indeed_exceeding_forty_chars(a, b) {\n  x\n  y\n  z\n  q\n}\n',
  g2: 'function_with_a_very_long_name_indeed_exceeding_forty_chars(a, b) {\n  x\n  y\n  z\n  Q\n}\n',
  h1: 'abc   \n1\n2\n3\n4\n5\n',
  h2: 'abc   \n1\n2\n3\n4\n5x\n',
  ins: 'a\nb\nc\nNEW\nd\ne\nf\ng\nh\ni\nj\n',
  rep: 'a\nb\nP\nQ\nR\nd\ne\nf\ng\nh\ni\nj\n',
  ten: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n',
  ten2: 'a\nb\nX\nd\ne\nf\ng\nh\nY\nj\n',
  ten3: 'a\nb\nX\nd\ne\nf\ng\nh\ni\nY\n',
  twelve: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n',
  twelve2: '1\n2\nX\n4\n5\nY\n7\n8\n9\n10\n11\n12\n',
  twelve3: '1\n2\nX\n4\n5\n6\nY\n8\n9\n10\n11\n12\n',
  x1: 'x\n',
}

// `context` is the number of unchanged lines around a hunk, and is not read
// for the normal format; `showFunction` is -p, which names each hunk.
export const RECORDINGS = [
  {
    command: 'diff ten ten2',
    names: ['ten', 'ten2'], format: 'normal', context: 0, showFunction: false,
    stdout: '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n',
  },
  {
    command: 'diff -u ten ten2',
    names: ['ten', 'ten2'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- ten\n+++ ten2\n@@ -1,10 +1,10 @@\n a\n b\n-c\n+X\n d\n e\n f\n g\n h\n-i\n+Y\n j\n',
  },
  {
    command: 'diff -u ten ten3',
    names: ['ten', 'ten3'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- ten\n+++ ten3\n@@ -1,10 +1,10 @@\n a\n b\n-c\n+X\n d\n e\n f\n g\n h\n i\n-j\n+Y\n',
  },
  {
    command: 'diff -U1 ten ten2',
    names: ['ten', 'ten2'], format: 'unified', context: 1, showFunction: false,
    stdout: '--- ten\n+++ ten2\n@@ -2,3 +2,3 @@\n b\n-c\n+X\n d\n@@ -8,3 +8,3 @@\n h\n-i\n+Y\n j\n',
  },
  {
    command: 'diff -U0 ten ten2',
    names: ['ten', 'ten2'], format: 'unified', context: 0, showFunction: false,
    stdout: '--- ten\n+++ ten2\n@@ -3 +3 @@\n-c\n+X\n@@ -9 +9 @@\n-i\n+Y\n',
  },
  {
    command: 'diff -U1000000000000000000000 ten ten2',
    names: ['ten', 'ten2'], format: 'unified', context: 1000000000000000000000, showFunction: false,
    stdout: '--- ten\n+++ ten2\n@@ -1,10 +1,10 @@\n a\n b\n-c\n+X\n d\n e\n f\n g\n h\n-i\n+Y\n j\n',
  },
  {
    command: 'diff -c ten ten2',
    names: ['ten', 'ten2'], format: 'context', context: 3, showFunction: false,
    stdout: '*** ten\n--- ten2\n***************\n*** 1,10 ****\n  a\n  b\n! c\n  d\n  e\n  f\n  g\n  h\n! i\n  j\n--- 1,10 ----\n  a\n  b\n! X\n  d\n  e\n  f\n  g\n  h\n! Y\n  j\n',
  },
  {
    command: 'diff -C1 ten ten2',
    names: ['ten', 'ten2'], format: 'context', context: 1, showFunction: false,
    stdout: '*** ten\n--- ten2\n***************\n*** 2,4 ****\n  b\n! c\n  d\n--- 2,4 ----\n  b\n! X\n  d\n***************\n*** 8,10 ****\n  h\n! i\n  j\n--- 8,10 ----\n  h\n! Y\n  j\n',
  },
  {
    command: 'diff -C0 ten ten2',
    names: ['ten', 'ten2'], format: 'context', context: 0, showFunction: false,
    stdout: '*** ten\n--- ten2\n***************\n*** 3 ****\n! c\n--- 3 ----\n! X\n***************\n*** 9 ****\n! i\n--- 9 ----\n! Y\n',
  },
  {
    command: 'diff -c ten ins',
    names: ['ten', 'ins'], format: 'context', context: 3, showFunction: false,
    stdout: '*** ten\n--- ins\n***************\n*** 1,6 ****\n--- 1,7 ----\n  a\n  b\n  c\n+ NEW\n  d\n  e\n  f\n',
  },
  {
    command: 'diff -c ten del',
    names: ['ten', 'del'], format: 'context', context: 3, showFunction: false,
    stdout: '*** ten\n--- del\n***************\n*** 1,6 ****\n  a\n  b\n- c\n  d\n  e\n  f\n--- 1,5 ----\n',
  },
  {
    command: 'diff ten rep',
    names: ['ten', 'rep'], format: 'normal', context: 0, showFunction: false,
    stdout: '3c3,5\n< c\n---\n> P\n> Q\n> R\n',
  },
  {
    command: 'diff ten app',
    names: ['ten', 'app'], format: 'normal', context: 0, showFunction: false,
    stdout: '10a11,12\n> k\n> l\n',
  },
  {
    command: 'diff app ten',
    names: ['app', 'ten'], format: 'normal', context: 0, showFunction: false,
    stdout: '11,12d10\n< k\n< l\n',
  },
  {
    command: 'diff -c ten rep',
    names: ['ten', 'rep'], format: 'context', context: 3, showFunction: false,
    stdout: '*** ten\n--- rep\n***************\n*** 1,6 ****\n  a\n  b\n! c\n  d\n  e\n  f\n--- 1,8 ----\n  a\n  b\n! P\n! Q\n! R\n  d\n  e\n  f\n',
  },
  {
    command: 'diff -u ten rep',
    names: ['ten', 'rep'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- ten\n+++ rep\n@@ -1,6 +1,8 @@\n a\n b\n-c\n+P\n+Q\n+R\n d\n e\n f\n',
  },
  {
    command: 'diff -u ten app',
    names: ['ten', 'app'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- ten\n+++ app\n@@ -8,3 +8,5 @@\n h\n i\n j\n+k\n+l\n',
  },
  {
    command: 'diff -u app ten',
    names: ['app', 'ten'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- app\n+++ ten\n@@ -8,5 +8,3 @@\n h\n i\n j\n-k\n-l\n',
  },
  {
    command: 'diff a1 a2',
    names: ['a1', 'a2'], format: 'normal', context: 0, showFunction: false,
    stdout: '1c1\n< a\n---\n> a\n\\ No newline at end of file\n',
  },
  {
    command: 'diff -u a1 a2',
    names: ['a1', 'a2'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- a1\n+++ a2\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n',
  },
  {
    command: 'diff -c a1 a2',
    names: ['a1', 'a2'], format: 'context', context: 3, showFunction: false,
    stdout: '*** a1\n--- a2\n***************\n*** 1 ****\n! a\n--- 1 ----\n! a\n\\ No newline at end of file\n',
  },
  {
    command: 'diff a2 a1',
    names: ['a2', 'a1'], format: 'normal', context: 0, showFunction: false,
    stdout: '1c1\n< a\n\\ No newline at end of file\n---\n> a\n',
  },
  {
    command: 'diff -u a2 a1',
    names: ['a2', 'a1'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- a2\n+++ a1\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n',
  },
  {
    command: 'diff -c a2 a1',
    names: ['a2', 'a1'], format: 'context', context: 3, showFunction: false,
    stdout: '*** a2\n--- a1\n***************\n*** 1 ****\n! a\n\\ No newline at end of file\n--- 1 ----\n! a\n',
  },
  {
    command: 'diff -u empty x1',
    names: ['empty', 'x1'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- empty\n+++ x1\n@@ -0,0 +1 @@\n+x\n',
  },
  {
    command: 'diff -u x1 empty',
    names: ['x1', 'empty'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- x1\n+++ empty\n@@ -1 +0,0 @@\n-x\n',
  },
  {
    command: 'diff empty x1',
    names: ['empty', 'x1'], format: 'normal', context: 0, showFunction: false,
    stdout: '0a1\n> x\n',
  },
  {
    command: 'diff x1 empty',
    names: ['x1', 'empty'], format: 'normal', context: 0, showFunction: false,
    stdout: '1d0\n< x\n',
  },
  {
    command: 'diff -c empty x1',
    names: ['empty', 'x1'], format: 'context', context: 3, showFunction: false,
    stdout: '*** empty\n--- x1\n***************\n*** 0 ****\n--- 1 ----\n+ x\n',
  },
  {
    command: 'diff -c x1 empty',
    names: ['x1', 'empty'], format: 'context', context: 3, showFunction: false,
    stdout: '*** x1\n--- empty\n***************\n*** 1 ****\n- x\n--- 0 ----\n',
  },
  {
    command: 'diff -U0 a1 app',
    names: ['a1', 'app'], format: 'unified', context: 0, showFunction: false,
    stdout: '--- a1\n+++ app\n@@ -1,0 +2,11 @@\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n+j\n+k\n+l\n',
  },
  {
    command: 'diff -U0 app a1',
    names: ['app', 'a1'], format: 'unified', context: 0, showFunction: false,
    stdout: '--- app\n+++ a1\n@@ -2,11 +1,0 @@\n-b\n-c\n-d\n-e\n-f\n-g\n-h\n-i\n-j\n-k\n-l\n',
  },
  {
    command: 'diff -C0 a1 app',
    names: ['a1', 'app'], format: 'context', context: 0, showFunction: false,
    stdout: '*** a1\n--- app\n***************\n*** 1 ****\n--- 2,12 ----\n+ b\n+ c\n+ d\n+ e\n+ f\n+ g\n+ h\n+ i\n+ j\n+ k\n+ l\n',
  },
  {
    command: 'diff -C0 app a1',
    names: ['app', 'a1'], format: 'context', context: 0, showFunction: false,
    stdout: '*** app\n--- a1\n***************\n*** 2,12 ****\n- b\n- c\n- d\n- e\n- f\n- g\n- h\n- i\n- j\n- k\n- l\n--- 1 ----\n',
  },
  {
    command: 'diff -U1 twelve twelve2',
    names: ['twelve', 'twelve2'], format: 'unified', context: 1, showFunction: false,
    stdout: '--- twelve\n+++ twelve2\n@@ -2,6 +2,6 @@\n 2\n-3\n+X\n 4\n 5\n-6\n+Y\n 7\n',
  },
  {
    command: 'diff -U1 twelve twelve3',
    names: ['twelve', 'twelve3'], format: 'unified', context: 1, showFunction: false,
    stdout: '--- twelve\n+++ twelve3\n@@ -2,3 +2,3 @@\n 2\n-3\n+X\n 4\n@@ -6,3 +6,3 @@\n 6\n-7\n+Y\n 8\n',
  },
  {
    command: 'diff -C1 twelve twelve2',
    names: ['twelve', 'twelve2'], format: 'context', context: 1, showFunction: false,
    stdout: '*** twelve\n--- twelve2\n***************\n*** 2,7 ****\n  2\n! 3\n  4\n  5\n! 6\n  7\n--- 2,7 ----\n  2\n! X\n  4\n  5\n! Y\n  7\n',
  },
  {
    command: 'diff -C1 twelve twelve3',
    names: ['twelve', 'twelve3'], format: 'context', context: 1, showFunction: false,
    stdout: '*** twelve\n--- twelve3\n***************\n*** 2,4 ****\n  2\n! 3\n  4\n--- 2,4 ----\n  2\n! X\n  4\n***************\n*** 6,8 ****\n  6\n! 7\n  8\n--- 6,8 ----\n  6\n! Y\n  8\n',
  },
  {
    command: 'diff -up f1 f2',
    names: ['f1', 'f2'], format: 'unified', context: 3, showFunction: true,
    stdout: '--- f1\n+++ f2\n@@ -3,13 +3,13 @@ int main() {\n   int b;\n   int c;\n   int d;\n-  int e;\n+  int E;\n   return 0;\n }\n void other() {\n   x;\n   y;\n   z;\n-  w;\n+  W;\n   v;\n }\n',
  },
  {
    command: 'diff -cp f1 f2',
    names: ['f1', 'f2'], format: 'context', context: 3, showFunction: true,
    stdout: '*** f1\n--- f2\n*************** int main() {\n*** 3,15 ****\n    int b;\n    int c;\n    int d;\n!   int e;\n    return 0;\n  }\n  void other() {\n    x;\n    y;\n    z;\n!   w;\n    v;\n  }\n--- 3,15 ----\n    int b;\n    int c;\n    int d;\n!   int E;\n    return 0;\n  }\n  void other() {\n    x;\n    y;\n    z;\n!   W;\n    v;\n  }\n',
  },
  {
    command: 'diff -up g1 g2',
    names: ['g1', 'g2'], format: 'unified', context: 3, showFunction: true,
    stdout: '--- g1\n+++ g2\n@@ -2,5 +2,5 @@ function_with_a_very_long_name_indeed_ex\n   x\n   y\n   z\n-  q\n+  Q\n }\n',
  },
  {
    command: 'diff -up h1 h2',
    names: ['h1', 'h2'], format: 'unified', context: 3, showFunction: true,
    stdout: '--- h1\n+++ h2\n@@ -3,4 +3,4 @@ abc\n 2\n 3\n 4\n-5\n+5x\n',
  },
  {
    command: 'diff -up ten ins',
    names: ['ten', 'ins'], format: 'unified', context: 3, showFunction: true,
    stdout: '--- ten\n+++ ins\n@@ -1,6 +1,7 @@\n a\n b\n c\n+NEW\n d\n e\n f\n',
  },
  {
    command: 'diff cr1 cr3',
    names: ['cr1', 'cr3'], format: 'normal', context: 0, showFunction: false,
    stdout: '1,2c1,2\n< a\r\n< b\r\n---\n> a\n> b\n',
  },
  {
    command: 'diff blank1 blank2',
    names: ['blank1', 'blank2'], format: 'normal', context: 0, showFunction: false,
    stdout: '2,3d1\n< \n< \n',
  },
  {
    command: 'diff -u blank1 blank2',
    names: ['blank1', 'blank2'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- blank1\n+++ blank2\n@@ -1,4 +1,2 @@\n a\n-\n-\n b\n',
  },
  {
    command: 'diff -c blank1 blank2',
    names: ['blank1', 'blank2'], format: 'context', context: 3, showFunction: false,
    stdout: '*** blank1\n--- blank2\n***************\n*** 1,4 ****\n  a\n- \n- \n  b\n--- 1,2 ----\n',
  },
  {
    command: 'diff -u big big2',
    names: ['big', 'big2'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- big\n+++ big2\n@@ -2,6 +2,7 @@\n 2\n 3\n 4\n+NEW1\n 5\n 6\n 7\n@@ -17,7 +18,7 @@\n 17\n 18\n 19\n-20\n+twenty\n 21\n 22\n 23\n',
  },
  {
    command: 'diff -c big big2',
    names: ['big', 'big2'], format: 'context', context: 3, showFunction: false,
    stdout: '*** big\n--- big2\n***************\n*** 2,7 ****\n--- 2,8 ----\n  2\n  3\n  4\n+ NEW1\n  5\n  6\n  7\n***************\n*** 17,23 ****\n  17\n  18\n  19\n! 20\n  21\n  22\n  23\n--- 18,24 ----\n  17\n  18\n  19\n! twenty\n  21\n  22\n  23\n',
  },
  {
    command: 'diff big big2',
    names: ['big', 'big2'], format: 'normal', context: 0, showFunction: false,
    stdout: '4a5\n> NEW1\n20c21\n< 20\n---\n> twenty\n',
  },
  {
    command: 'diff -U1 big big2',
    names: ['big', 'big2'], format: 'unified', context: 1, showFunction: false,
    stdout: '--- big\n+++ big2\n@@ -4,2 +4,3 @@\n 4\n+NEW1\n 5\n@@ -19,3 +20,3 @@\n 19\n-20\n+twenty\n 21\n',
  },
  {
    command: 'diff -u big2 big',
    names: ['big2', 'big'], format: 'unified', context: 3, showFunction: false,
    stdout: '--- big2\n+++ big\n@@ -2,7 +2,6 @@\n 2\n 3\n 4\n-NEW1\n 5\n 6\n 7\n@@ -18,7 +17,7 @@\n 17\n 18\n 19\n-twenty\n+20\n 21\n 22\n 23\n',
  },
  {
    command: 'diff -c big2 big',
    names: ['big2', 'big'], format: 'context', context: 3, showFunction: false,
    stdout: '*** big2\n--- big\n***************\n*** 2,8 ****\n  2\n  3\n  4\n- NEW1\n  5\n  6\n  7\n--- 2,7 ----\n***************\n*** 18,24 ****\n  17\n  18\n  19\n! twenty\n  21\n  22\n  23\n--- 17,23 ----\n  17\n  18\n  19\n! 20\n  21\n  22\n  23\n',
  },
  {
    command: 'diff big2 big',
    names: ['big2', 'big'], format: 'normal', context: 0, showFunction: false,
    stdout: '5d4\n< NEW1\n21c20\n< twenty\n---\n> 20\n',
  },
]
