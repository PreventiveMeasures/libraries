// Output recorded from tar (GNU tar) 1.35 by scripts/record-gnu-tar.js — see there
// for the trees and the options. Do not edit by hand; run the script.
//
// Every recording is a list of entries, in the order they were given to
// tar and with every field filled in, and the archive tar wrote for them:
// its bytes in hex, with each run of zero bytes as its length in brackets.
// `blocking` is the -b it was written with.

export const bytesOf = ({ archive }) => Uint8Array.from(
  [...archive.matchAll(/\[(\d+)\]|([0-9a-f]{2})/gu)].flatMap(([, zeros, hex]) => (zeros ? Array.from({ length: Number(zeros) }, () => 0) : [Number.parseInt(hex, 16)])),
)

export const RECORDINGS = [
  {
    "command": "tar --format=gnu -b 20 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- a.txt dir dir/b.bin empty link",
    "format": "gnu",
    "blocking": 20,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?F"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "a.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303036[1]3133363032373630343030[1]303036373137[1]2030[100]75737461722020[248]68656c6c6f0a[506]6469722f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353230[1]2035[100]75737461722020[248]6469722f622e62696e[91]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303031373530[1]3133363032373630343030[1]303037343336[1]2030[100]75737461722020[248]21282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f46[24]656d707479[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037303131[1]2030[100]75737461722020[248]6c696e6b[96]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037363030[1]2032612e747874[95]75737461722020[6392]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- a.txt dir dir/b.bin empty link",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?F"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "a.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303036[1]3133363032373630343030[1]303036373137[1]2030[100]75737461722020[248]68656c6c6f0a[506]6469722f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353230[1]2035[100]75737461722020[248]6469722f622e62696e[91]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303031373530[1]3133363032373630343030[1]303037343336[1]2030[100]75737461722020[248]21282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f46[24]656d707479[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037303131[1]2030[100]75737461722020[248]6c696e6b[96]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037363030[1]2032612e747874[95]75737461722020[1272]"
  },
  {
    "command": "tar --format=ustar -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- a.txt dir dir/b.bin empty link",
    "format": "ustar",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?F"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "a.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303036[1]3133363032373630343030[1]303036373537[1]2030[100]7573746172[1]3030[247]68656c6c6f0a[506]6469722f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353630[1]2035[100]7573746172[1]3030[247]6469722f622e62696e[91]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303031373530[1]3133363032373630343030[1]303037343736[1]2030[100]7573746172[1]3030[247]21282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f46[24]656d707479[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037303531[1]2030[100]7573746172[1]3030[247]6c696e6b[96]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037363430[1]2032612e747874[95]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime -cf - -- a.txt dir dir/b.bin empty link",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?F"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "a.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303036[1]3133363032373630343030[1]303036373537[1]2030[100]7573746172[1]3030[247]68656c6c6f0a[506]6469722f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353630[1]2035[100]7573746172[1]3030[247]6469722f622e62696e[91]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303031373530[1]3133363032373630343030[1]303037343736[1]2030[100]7573746172[1]3030[247]21282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f464d545b626970777e272e353c434a51585f666d747b242b323940474e555c636a717821282f363d444b525960676e757c252c333a41484f565d646b7279222930373e454c535a61686f767d262d343b424950575e656c737a232a31383f46[24]656d707479[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037303531[1]2030[100]7573746172[1]3030[247]6c696e6b[96]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037363430[1]2032612e747874[95]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir longlink ü.txt ülink",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "longlink",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "x"
      },
      {
        "name": "ülink",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "ü.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333333232[1]2030[100]75737461722020[248]2e2f2e2f404c6f6e674c696e6b[87]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030313436[1]3030303030303030303030[1]303037373734[1]204c[100]75737461722020[248]6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d[411]6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333313536[1]2030[100]75737461722020[248]2e2f2e2f404c6f6e674c696e6b[87]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030323330[1]3030303030303030303030[1]303037373636[1]204c[100]75737461722020[248]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f[361]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331333632[1]2035[100]75737461722020[248]2e2f2e2f404c6f6e674c696e6b[87]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030333632[1]3030303030303030303030[1]303037373734[1]204c[100]75737461722020[248]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666[271]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331333532[1]2030[100]75737461722020[248]2e2f2e2f404c6f6e674c696e6b[87]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030333637[1]3030303030303030303030[1]303130303031[1]204c[100]75737461722020[248]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666662d6469722f[266]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331333632[1]2035[100]75737461722020[248]2e2f2e2f404c6f6e674c696e6b[87]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030333632[1]3030303030303030303030[1]303037373733[1]204b[100]75737461722020[248]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666[271]6c6f6e676c696e6b[92]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333313231[1]20326464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646475737461722020[248]c3bc2e747874[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303031[1]3133363032373630343030[1]303037333530[1]2030[100]75737461722020[248]78[511]c3bc6c696e6b[94]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303131303335[1]2032c3bc2e747874[94]75737461722020[1272]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime -cf - -- nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir longlink ü.txt ülink",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "longlink",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "x"
      },
      {
        "name": "ülink",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "ü.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333333632[1]2030[100]7573746172[1]3030[247]2e2f506178486561646572732f6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030313537[1]3133363032373630343030[1]303332373133[1]2078[100]7573746172[1]3030[247]31313120706174683d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d0a[401]6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333323136[1]2030[100]7573746172[1]3030[247]2e2f506178486561646572732f64646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030363434[1]30303030303030[1]30303030303030[1]3030303030303030323431[1]3133363032373630343030[1]303331323636[1]2078[100]7573746172[1]3030[247]31363120706174683d6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f0a[351]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331343232[1]2035[100]7573746172[1]3030[247]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030363434[1]30303030303030[1]30303030303030[1]3030303030303030333733[1]3133363032373630343030[1]303331353337[1]2078[100]7573746172[1]3030[247]32353120706174683d6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666660a[261]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331343132[1]2030[100]7573746172[1]3030[247]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030363434[1]30303030303030[1]30303030303030[1]3030303030303030343030[1]3133363032373630343030[1]303331353236[1]2078[100]7573746172[1]3030[247]32353620706174683d6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666662d6469722f0a[256]6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646430303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303331343232[1]2035[100]7573746172[1]3030[247]2e2f506178486561646572732f6c6f6e676c696e6b[79]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030333737[1]3133363032373630343030[1]303132303432[1]2078[100]7573746172[1]3030[247]323535206c696e6b706174683d6464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464642f6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666660a[257]6c6f6e676c696e6b[92]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333313631[1]2032646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464647573746172[1]3030[247]2e2f506178486561646572732fc3bc2e747874[81]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303137[1]3133363032373630343030[1]303131373130[1]2078[100]7573746172[1]3030[247]313520706174683dc3bc2e7478740a[497]c3bc2e747874[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303031[1]3133363032373630343030[1]303037343130[1]2030[100]7573746172[1]3030[247]78[511]2e2f506178486561646572732fc3bc6c696e6b[81]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303137[1]3133363032373630343030[1]303131373530[1]2078[100]7573746172[1]3030[247]313520706174683dc3bc6c696e6b0a[497]c3bc6c696e6b[94]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303131303735[1]2032c3bc2e747874[94]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=ustar -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir ü.txt ülink",
    "format": "ustar",
    "blocking": 1,
    "entries": [
      {
        "name": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-dir",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "x"
      },
      {
        "name": "ülink",
        "type": "symlink",
        "mode": 511,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "ü.txt",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303333333632[1]2030[100]7573746172[1]3030[247]666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666[10]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303635313536[1]2030[100]7573746172[1]3030[80]646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464[17]6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666662d6469722f[5]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303636303231[1]2035[100]7573746172[1]3030[80]646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464[17]c3bc2e747874[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303031[1]3133363032373630343030[1]303037343130[1]2030[100]7573746172[1]3030[247]78[511]c3bc6c696e6b[94]30303030373737[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303131303735[1]2032c3bc2e747874[94]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- bdev cdev fifo h1 h2 sub sub/h3",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "bdev",
        "type": "block-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 7,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "cdev",
        "type": "character-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 1,
        "devminor": 3,
        "data": ""
      },
      {
        "name": "fifo",
        "type": "fifo",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "h1",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "data"
      },
      {
        "name": "h2",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub/h3",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "62646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130303436[1]2034[100]75737461722020[65]30303030303037[1]30303030303030[168]63646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130303433[1]2033[100]75737461722020[65]30303030303031[1]30303030303033[168]6669666f[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036363034[1]2036[100]75737461722020[248]6831[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303034[1]3133363032373630343030[1]303036313637[1]2030[100]75737461722020[248]64617461[508]6832[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036343136[1]20316831[98]75737461722020[248]7375622f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353333[1]2035[100]75737461722020[248]7375622f6833[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037323130[1]20316831[98]75737461722020[1272]"
  },
  {
    "command": "tar --format=ustar -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- bdev cdev fifo h1 h2 sub sub/h3",
    "format": "ustar",
    "blocking": 1,
    "entries": [
      {
        "name": "bdev",
        "type": "block-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 7,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "cdev",
        "type": "character-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 1,
        "devminor": 3,
        "data": ""
      },
      {
        "name": "fifo",
        "type": "fifo",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "h1",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "data"
      },
      {
        "name": "h2",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub/h3",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "62646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130313036[1]2034[100]7573746172[1]3030[64]30303030303037[1]30303030303030[168]63646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130313033[1]2033[100]7573746172[1]3030[64]30303030303031[1]30303030303033[168]6669666f[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036363434[1]2036[100]7573746172[1]3030[247]6831[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303034[1]3133363032373630343030[1]303036323237[1]2030[100]7573746172[1]3030[247]64617461[508]6832[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036343536[1]20316831[98]7573746172[1]3030[247]7375622f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353733[1]2035[100]7573746172[1]3030[247]7375622f6833[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037323530[1]20316831[98]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime -cf - -- bdev cdev fifo h1 h2 sub sub/h3",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "bdev",
        "type": "block-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 7,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "cdev",
        "type": "character-device",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 1,
        "devminor": 3,
        "data": ""
      },
      {
        "name": "fifo",
        "type": "fifo",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "h1",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "data"
      },
      {
        "name": "h2",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "sub/h3",
        "type": "hardlink",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "h1",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      }
    ],
    "archive": "62646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130313036[1]2034[100]7573746172[1]3030[64]30303030303037[1]30303030303030[168]63646576[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303130313033[1]2033[100]7573746172[1]3030[64]30303030303031[1]30303030303033[168]6669666f[96]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036363434[1]2036[100]7573746172[1]3030[247]6831[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303034[1]3133363032373630343030[1]303036323237[1]2030[100]7573746172[1]3030[247]64617461[508]6832[98]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036343536[1]20316831[98]7573746172[1]3030[247]7375622f[96]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036353733[1]2035[100]7573746172[1]3030[247]7375622f6833[94]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303037323530[1]20316831[98]7573746172[1]3030[1271]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --owner=:3000000 --group=:3000000 -cf - -- a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 3000000,
        "gid": 3000000,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]80[4]2dc6c080[4]2dc6c03030303030303030303032[1]3133363032373630343030[1]303037363231[1]2030[100]75737461722020[248]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime --owner=:3000000 --group=:3000000 -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 3000000,
        "gid": 3000000,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f506178486561646572732f612e747874[82]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303336[1]3133363032373630343030[1]303131323533[1]2078[100]7573746172[1]3030[247]3135207569643d333030303030300a3135206769643d333030303030300a[482]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303036373533[1]2030[100]7573746172[1]3030[247]6869[1534]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --mtime=@100000000000 -cf - -- a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 100000000000,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]80[6]174876e8[1]303036373333[1]2030[100]75737461722020[248]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime --mtime=@100000000000 -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 100000000000,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f506178486561646572732f612e747874[82]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303236[1]3737373737373737373737[1]303131333332[1]2078[100]7573746172[1]3030[247]3232206d74696d653d3130303030303030303030300a[490]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3030303030303030303030[1]303036373136[1]2030[100]7573746172[1]3030[247]6869[1534]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --mtime=@-1 -cf - -- a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": -1,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]ffffffffffffffffffffffff303133363232[1]2030[100]75737461722020[248]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime --mtime=@-1 -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": -1,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f506178486561646572732f612e747874[82]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303134[1]3030303030303030303030[1]303131323132[1]2078[100]7573746172[1]3030[247]3132206d74696d653d2d310a[500]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3030303030303030303030[1]303036373136[1]2030[100]7573746172[1]3030[247]6869[1534]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=root:0 --group=root:0 -cf - -- a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "root",
        "gname": "root",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303130353233[1]2030[100]75737461722020[1]726f6f74[28]726f6f74[211]6869[1534]"
  },
  {
    "command": "tar --format=ustar -b 1 --no-recursion --owner=abcdefghijklmnopqrstuvwxyzabcde:0 --group=abcdefghijklmnopqrstuvwxyzabcde:0 -cf - -- a.txt",
    "format": "ustar",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "abcdefghijklmnopqrstuvwxyzabcde",
        "gname": "abcdefghijklmnopqrstuvwxyzabcde",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303234303037[1]2030[100]7573746172[1]30306162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[1]6162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[184]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=abcdefghijklmnopqrstuvwxyzabcde:0 --group=abcdefghijklmnopqrstuvwxyzabcde:0 --pax-option=delete=atime,delete=ctime -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "abcdefghijklmnopqrstuvwxyzabcde",
        "gname": "abcdefghijklmnopqrstuvwxyzabcde",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303234303037[1]2030[100]7573746172[1]30306162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[1]6162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[184]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=abcdefghijklmnopqrstuvwxyzabcdefghij:0 --group=abcdefghijklmnopqrstuvwxyzabcdefghij:0 --pax-option=delete=atime,delete=ctime -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "abcdefghijklmnopqrstuvwxyzabcdefghij",
        "gname": "abcdefghijklmnopqrstuvwxyzabcdefghij",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f506178486561646572732f612e747874[82]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030313334[1]3133363032373630343030[1]303131323532[1]2078[100]7573746172[1]3030[247]343620756e616d653d6162636465666768696a6b6c6d6e6f707172737475767778797a6162636465666768696a0a343620676e616d653d6162636465666768696a6b6c6d6e6f707172737475767778797a6162636465666768696a0a[420]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303234303037[1]2030[100]7573746172[1]30306162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[1]6162636465666768696a6b6c6d6e6f707172737475767778797a6162636465[184]6869[1534]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=ünïcode:0 --group=gröup:0 -cf - -- a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "ünïcode",
        "gname": "gröup",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303132373734[1]2030[100]75737461722020[1]c3bc6ec3af636f6465[23]6772c3b67570[209]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=ünïcode:0 --group=gröup:0 --pax-option=delete=atime,delete=ctime -cf - -- a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "ünïcode",
        "gname": "gröup",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f506178486561646572732f612e747874[82]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303433[1]3133363032373630343030[1]303131323531[1]2078[100]7573746172[1]3030[247]313920756e616d653dc3bc6ec3af636f64650a313620676e616d653d6772c3b675700a[477]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303133303334[1]2030[100]7573746172[1]3030c3bc6ec3af636f6465[23]6772c3b67570[209]6869[1534]"
  },
  {
    "command": "tar --format=gnu -b 20 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -T /dev/null",
    "format": "gnu",
    "blocking": 20,
    "entries": [],
    "archive": "[10240]"
  },
  {
    "command": "tar --format=gnu -b 1 --no-recursion --owner=0 --group=0 --numeric-owner -cf - -- . a.txt",
    "format": "gnu",
    "blocking": 1,
    "entries": [
      {
        "name": ".",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f[98]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036303737[1]2035[100]75737461722020[248]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303036373133[1]2030[100]75737461722020[248]6869[1534]"
  },
  {
    "command": "tar --format=posix -b 1 --no-recursion --owner=0 --group=0 --numeric-owner --pax-option=delete=atime,delete=ctime -cf - -- . a.txt",
    "format": "pax",
    "blocking": 1,
    "entries": [
      {
        "name": ".",
        "type": "directory",
        "mode": 493,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": ""
      },
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "uid": 0,
        "gid": 0,
        "mtime": 1577836800,
        "uname": "",
        "gname": "",
        "linkname": "",
        "devmajor": 0,
        "devminor": 0,
        "data": "hi"
      }
    ],
    "archive": "2e2f[98]30303030373535[1]30303030303030[1]30303030303030[1]3030303030303030303030[1]3133363032373630343030[1]303036313337[1]2035[100]7573746172[1]3030[247]612e747874[95]30303030363434[1]30303030303030[1]30303030303030[1]3030303030303030303032[1]3133363032373630343030[1]303036373533[1]2030[100]7573746172[1]3030[247]6869[1534]"
  }
]
