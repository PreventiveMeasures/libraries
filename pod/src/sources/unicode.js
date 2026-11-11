// What a name is on a Mac and in each release of Ruby, by which CocoaPods compares names.

// As macOS takes a name, whatever its case and normalization.
export const fold = (name) => name.normalize('NFD').toLowerCase()

// Letters whose case Ruby maps otherwise in one release than another: cased letters encoded after Unicode 12.1,
// which Ruby 2.6 reads, and older ones that map to them, from Unicode 17's DerivedAge.txt.
export const CASE_UNSTABLE = new RegExp(`[${[
  String.raw`\u{19B}\u{264}\u{1C89}-\u{1C8A}\u{2C2F}\u{2C5F}\u{A7C0}-\u{A7C1}`,
  String.raw`\u{A7C7}-\u{A7DC}\u{A7F5}-\u{A7F6}\u{10570}-\u{1057A}`,
  String.raw`\u{1057C}-\u{1058A}\u{1058C}-\u{10592}\u{10594}-\u{10595}`,
  String.raw`\u{10597}-\u{105A1}\u{105A3}-\u{105B1}\u{105B3}-\u{105B9}`,
  String.raw`\u{105BB}-\u{105BC}\u{10D50}-\u{10D65}\u{10D70}-\u{10D85}`,
  String.raw`\u{16EA0}-\u{16EB8}\u{16EBB}-\u{16ED3}`,
].join('')}]`, 'u')
