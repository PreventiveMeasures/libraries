// Output recorded from GNU diff 3.10 in the C locale for pairs where a run of
// changes is free to sit in more than one place. Unlike gnu-diff.js, whose
// pairs each have one shortest change set, these pin where GNU puts the run
// as well as what it changes. Each was run as `diff <flags> a b` with the
// pair written to `a` and `b`. `body` is what `diff` returns, so the two label
// lines a unified or context diff opens with are left out, and `options` asks
// `diff` for the same output.

export const PAIRS = {
  // Functions added after `return ...;` in minified code. The added run can
  // start with the `}` closing that function or end with the `}` closing
  // the last one added. GNU starts it after the `}` and prints it as one
  // block, under -w too, where a `}` also matches an indented `  }`.
  functions: [
    'before();\nfunction qe(t, e) {\n  return n.data;\n}\nvar us = [];\nafter();\n',
    'BEFORE();\nfunction qe(t, e) {\n  return n.data;\n}\nfunction ds(t) {\n  let e = new Set();\n  for (let n of t) {\n    if (!n) continue;\n    let o = n;\n    e.add(o.file);\n    for (let r of o.evidence)\n      e.add(r.file);\n  }\n  return e;\n}\nfunction Cr(t) {\n  let e = we(t),\n    n = be(e);\n}\nfunction Tr(t) {\n  let e = new Map();\n  for (let n of Cr(t).own) {\n    let o = G(n);\n    o && e.set(o, o);\n  }\n  return e.size;\n}\nfunction Lr(t) {\n  let { directory: e, own: n } = Cr(t);\n}\nvar us = [];\nAFTER();\n',
  ],
  // Under -w, three blank lines and two `b();` against one of each: which
  // blank goes is free, and the one that goes next to the `b();` makes one
  // block of the two.
  blanks: [
    '\nb();\n\n\nb();\n',
    '  b();\n  \n',
  ],
  // Two blank lines go, and the files end in four they share. diff lets the
  // run into those only as far as its context lines, or --horizon-lines.
  'trailing-blanks': [
    '\na\n\n\n\n\n\n',
    'a\n\n\n\n\n',
  ],
  // Under -w the first lines match without being the same text, so they are
  // not part of what the files share at the start. Only the last `y` is
  // shared at the end, and the normal format leaves it out of the search.
  'shared-end': [
    ' x\ny\ny\n',
    'x\ny\n',
  ],
}

export const RECORDINGS = [
  {
    command: 'diff a b',
    pair: 'functions', options: { format: 'normal' },
    body: '1c1\n< before();\n---\n> BEFORE();\n4a5,30\n> function ds(t) {\n>   let e = new Set();\n>   for (let n of t) {\n>     if (!n) continue;\n>     let o = n;\n>     e.add(o.file);\n>     for (let r of o.evidence)\n>       e.add(r.file);\n>   }\n>   return e;\n> }\n> function Cr(t) {\n>   let e = we(t),\n>     n = be(e);\n> }\n> function Tr(t) {\n>   let e = new Map();\n>   for (let n of Cr(t).own) {\n>     let o = G(n);\n>     o && e.set(o, o);\n>   }\n>   return e.size;\n> }\n> function Lr(t) {\n>   let { directory: e, own: n } = Cr(t);\n> }\n6c32\n< after();\n---\n> AFTER();\n',
  },
  {
    command: 'diff -U0 a b',
    pair: 'functions', options: { context: 0 },
    body: '@@ -1 +1 @@\n-before();\n+BEFORE();\n@@ -4,0 +5,26 @@\n+function ds(t) {\n+  let e = new Set();\n+  for (let n of t) {\n+    if (!n) continue;\n+    let o = n;\n+    e.add(o.file);\n+    for (let r of o.evidence)\n+      e.add(r.file);\n+  }\n+  return e;\n+}\n+function Cr(t) {\n+  let e = we(t),\n+    n = be(e);\n+}\n+function Tr(t) {\n+  let e = new Map();\n+  for (let n of Cr(t).own) {\n+    let o = G(n);\n+    o && e.set(o, o);\n+  }\n+  return e.size;\n+}\n+function Lr(t) {\n+  let { directory: e, own: n } = Cr(t);\n+}\n@@ -6 +32 @@\n-after();\n+AFTER();\n',
  },
  {
    command: 'diff -u a b',
    pair: 'functions', options: {},
    body: '@@ -1,6 +1,32 @@\n-before();\n+BEFORE();\n function qe(t, e) {\n   return n.data;\n }\n+function ds(t) {\n+  let e = new Set();\n+  for (let n of t) {\n+    if (!n) continue;\n+    let o = n;\n+    e.add(o.file);\n+    for (let r of o.evidence)\n+      e.add(r.file);\n+  }\n+  return e;\n+}\n+function Cr(t) {\n+  let e = we(t),\n+    n = be(e);\n+}\n+function Tr(t) {\n+  let e = new Map();\n+  for (let n of Cr(t).own) {\n+    let o = G(n);\n+    o && e.set(o, o);\n+  }\n+  return e.size;\n+}\n+function Lr(t) {\n+  let { directory: e, own: n } = Cr(t);\n+}\n var us = [];\n-after();\n+AFTER();\n',
  },
  {
    command: 'diff -w a b',
    pair: 'functions', options: { format: 'normal', whitespace: 'all' },
    body: '1c1\n< before();\n---\n> BEFORE();\n4a5,30\n> function ds(t) {\n>   let e = new Set();\n>   for (let n of t) {\n>     if (!n) continue;\n>     let o = n;\n>     e.add(o.file);\n>     for (let r of o.evidence)\n>       e.add(r.file);\n>   }\n>   return e;\n> }\n> function Cr(t) {\n>   let e = we(t),\n>     n = be(e);\n> }\n> function Tr(t) {\n>   let e = new Map();\n>   for (let n of Cr(t).own) {\n>     let o = G(n);\n>     o && e.set(o, o);\n>   }\n>   return e.size;\n> }\n> function Lr(t) {\n>   let { directory: e, own: n } = Cr(t);\n> }\n6c32\n< after();\n---\n> AFTER();\n',
  },
  {
    command: 'diff -w -U0 a b',
    pair: 'functions', options: { context: 0, whitespace: 'all' },
    body: '@@ -1 +1 @@\n-before();\n+BEFORE();\n@@ -4,0 +5,26 @@\n+function ds(t) {\n+  let e = new Set();\n+  for (let n of t) {\n+    if (!n) continue;\n+    let o = n;\n+    e.add(o.file);\n+    for (let r of o.evidence)\n+      e.add(r.file);\n+  }\n+  return e;\n+}\n+function Cr(t) {\n+  let e = we(t),\n+    n = be(e);\n+}\n+function Tr(t) {\n+  let e = new Map();\n+  for (let n of Cr(t).own) {\n+    let o = G(n);\n+    o && e.set(o, o);\n+  }\n+  return e.size;\n+}\n+function Lr(t) {\n+  let { directory: e, own: n } = Cr(t);\n+}\n@@ -6 +32 @@\n-after();\n+AFTER();\n',
  },
  {
    command: 'diff -w -u a b',
    pair: 'functions', options: { whitespace: 'all' },
    body: '@@ -1,6 +1,32 @@\n-before();\n+BEFORE();\n function qe(t, e) {\n   return n.data;\n }\n+function ds(t) {\n+  let e = new Set();\n+  for (let n of t) {\n+    if (!n) continue;\n+    let o = n;\n+    e.add(o.file);\n+    for (let r of o.evidence)\n+      e.add(r.file);\n+  }\n+  return e;\n+}\n+function Cr(t) {\n+  let e = we(t),\n+    n = be(e);\n+}\n+function Tr(t) {\n+  let e = new Map();\n+  for (let n of Cr(t).own) {\n+    let o = G(n);\n+    o && e.set(o, o);\n+  }\n+  return e.size;\n+}\n+function Lr(t) {\n+  let { directory: e, own: n } = Cr(t);\n+}\n var us = [];\n-after();\n+AFTER();\n',
  },
  {
    command: 'diff -w a b',
    pair: 'blanks', options: { format: 'normal', whitespace: 'all' },
    body: '1d0\n< \n4,5d2\n< \n< b();\n',
  },
  {
    command: 'diff -w -U0 a b',
    pair: 'blanks', options: { context: 0, whitespace: 'all' },
    body: '@@ -1 +0,0 @@\n-\n@@ -4,2 +2,0 @@\n-\n-b();\n',
  },
  {
    command: 'diff -b -U0 a b',
    pair: 'blanks', options: { context: 0, whitespace: 'change' },
    body: '@@ -0,0 +1 @@\n+  b();\n@@ -2,4 +2,0 @@\n-b();\n-\n-\n-b();\n',
  },
  {
    command: 'diff -w -u a b',
    pair: 'blanks', options: { whitespace: 'all' },
    body: '@@ -1,5 +1,2 @@\n-\n b();\n \n-\n-b();\n',
  },
  {
    command: 'diff a b',
    pair: 'trailing-blanks', options: { format: 'normal' },
    body: '1d0\n< \n3d1\n< \n',
  },
  {
    command: 'diff -U0 a b',
    pair: 'trailing-blanks', options: { context: 0 },
    body: '@@ -1 +0,0 @@\n-\n@@ -3 +1,0 @@\n-\n',
  },
  {
    command: 'diff -U1 a b',
    pair: 'trailing-blanks', options: { context: 1 },
    body: '@@ -1,5 +1,3 @@\n-\n a\n \n-\n \n',
  },
  {
    command: 'diff -u a b',
    pair: 'trailing-blanks', options: {},
    body: '@@ -1,7 +1,5 @@\n-\n a\n \n \n \n-\n \n',
  },
  {
    command: 'diff -U5 a b',
    pair: 'trailing-blanks', options: { context: 5 },
    body: '@@ -1,7 +1,5 @@\n-\n a\n \n \n \n \n-\n',
  },
  {
    command: 'diff -C2 a b',
    pair: 'trailing-blanks', options: { format: 'context', context: 2 },
    body: '***************\n*** 1,7 ****\n- \n  a\n  \n  \n- \n  \n  \n--- 1,5 ----\n',
  },
  {
    command: 'diff --horizon-lines=1 a b',
    pair: 'trailing-blanks', options: { format: 'normal', horizon: 1 },
    body: '1d0\n< \n4d2\n< \n',
  },
  {
    command: 'diff --horizon-lines=9 a b',
    pair: 'trailing-blanks', options: { format: 'normal', horizon: 9 },
    body: '1d0\n< \n7d5\n< \n',
  },
  {
    command: 'diff -U1 --horizon-lines=4 a b',
    pair: 'trailing-blanks', options: { context: 1, horizon: 4 },
    body: '@@ -1,2 +1 @@\n-\n a\n@@ -6,2 +5 @@\n \n-\n',
  },
  {
    command: 'diff -w a b',
    pair: 'shared-end', options: { format: 'normal', whitespace: 'all' },
    body: '2d1\n< y\n',
  },
  {
    command: 'diff -w -u a b',
    pair: 'shared-end', options: { whitespace: 'all' },
    body: '@@ -1,3 +1,2 @@\n  x\n y\n-y\n',
  },
]
