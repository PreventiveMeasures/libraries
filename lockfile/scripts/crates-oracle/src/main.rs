// What the crates src/crate/ ports make of what scripts/record-crates.js
// hands it on stdin: versions, requirements and names, a string a line as
// `x` and its hex, each list ended by an empty line. Writes, for each
// requirement, a character for each version, `1` where it matches, `0`
// where it does not and `-` where the version does not parse, or `-` alone
// where the requirement does not; then, for each name, its folder on Unix
// and on Windows, in hex.

use semver::{Version, VersionReq};
use std::io::{self, BufRead};

fn unhex(line: &str) -> String {
    let line = &line[1..];
    let bytes = (0..line.len()).step_by(2).map(|i| u8::from_str_radix(&line[i..i + 2], 16).unwrap()).collect();
    String::from_utf8(bytes).unwrap()
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let lines: Vec<String> = io::stdin().lock().lines().map(Result::unwrap).collect();
    let mut lists = lines.split(|line| line.is_empty()).map(|list| list.iter().map(|line| unhex(line)).collect::<Vec<_>>());
    let (versions, reqs, names) = (lists.next().unwrap(), lists.next().unwrap(), lists.next().unwrap());
    let versions: Vec<Option<Version>> = versions.iter().map(|v| Version::parse(v).ok()).collect();
    for req in &reqs {
        match req.parse::<VersionReq>() {
            Err(_) => println!("-"),
            Ok(req) => println!("{}", versions.iter().map(|v| v.as_ref().map_or('-', |v| if req.matches(v) { '1' } else { '0' })).collect::<String>()),
        }
    }
    for name in &names {
        for windows in [false, true] {
            let options = sanitize_filename::Options { truncate: true, windows, replacement: "-" };
            println!("{}", hex(&sanitize_filename::sanitize_with_options(name, options)));
        }
    }
}
