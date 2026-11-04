// Characters whose case Ruby's String#downcase and #upcase map otherwise
// in one release than another, and than String#toLowerCase and
// #toUpperCase here: cased letters encoded after Unicode 12.1, which Ruby
// 2.6 reads, and older ones that map to them. Each is refused where
// CocoaPods compares a name by its case, as which release reads it is not
// known. Made from Unicode 17's DerivedAge.txt, the code points Node maps
// to another case whose age, or that of what they map to, is past 12.1;
// they take in every code point Ruby 3.3 maps otherwise than Node, but
// for the final sigma, which clean.js reads as Ruby does.
export const CASE_UNSTABLE = new RegExp(`[${[
  String.raw`\u{19B}\u{264}\u{1C89}-\u{1C8A}\u{2C2F}\u{2C5F}\u{A7C0}-\u{A7C1}`,
  String.raw`\u{A7C7}-\u{A7DC}\u{A7F5}-\u{A7F6}\u{10570}-\u{1057A}`,
  String.raw`\u{1057C}-\u{1058A}\u{1058C}-\u{10592}\u{10594}-\u{10595}`,
  String.raw`\u{10597}-\u{105A1}\u{105A3}-\u{105B1}\u{105B3}-\u{105B9}`,
  String.raw`\u{105BB}-\u{105BC}\u{10D50}-\u{10D65}\u{10D70}-\u{10D85}`,
  String.raw`\u{16EA0}-\u{16EB8}\u{16EBB}-\u{16ED3}`,
].join('')}]`, 'u')
