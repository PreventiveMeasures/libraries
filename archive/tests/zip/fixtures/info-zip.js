// Output recorded from This is Zip 3.0 (July 5th 2008), by Info-ZIP. and python3's zipfile by
// scripts/record-info-zip.js — see there for the trees and the options.
// Do not edit by hand; run the script.
//
// Every recording is a list of entries, in the order they were given, with
// every field filled in, and the archive written for them, in base64.

export const bytesOf = ({ archive }) => Uint8Array.from(atob(archive), (c) => c.codePointAt(0))

export const RECORDINGS = [
  {
    "command": "TZ=UTC zip -q -y -0 out.zip -- a.txt dir dir/b.bin empty link ü.txt exec",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "hello hello hello hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "mtime": 1577836800,
        "linkname": "a.txt",
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "x"
      },
      {
        "name": "exec",
        "type": "file",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": "#!/bin/sh\n"
      }
    ],
    "archive": "UEsDBAoAAAAAAAAAIVAAiFkLGAAAABgAAAAFABwAYS50eHRVVAkAAwDhC14A4QtedXgLAAEEAAAAAAQAAAAAaGVsbG8gaGVsbG8gaGVsbG8gaGVsbG8KUEsDBAoAAAAAAAAAIVAAAAAAAAAAAAAAAAAEABwAZGlyL1VUCQADAOELXgDhC151eAsAAQQAAAAABAAAAABQSwMECgAAAAAAAAAhUEKpHt64CwAAuAsAAAkAHABkaXIvYi5iaW5VVAkAAwDhC14A4QtedXgLAAEEAAAAAAQAAAAAISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAUEsDBAoAAAAAAAAAIVAAAAAAAAAAAAAAAAAFABwAZW1wdHlVVAkAAwDhC14A4QtedXgLAAEEAAAAAAQAAAAAUEsDBAoAAAAAAAAAIVC69+vBBQAAAAUAAAAEABwAbGlua1VUCQADAOELXgDhC151eAsAAQQAAAAABAAAAABhLnR4dFBLAwQKAAAAAAAAACFQgxbcjAEAAAABAAAABgAcAMO8LnR4dFVUCQADAOELXgDhC151eAsAAQQAAAAABAAAAAB4UEsDBAoAAAAAAAAAIVAdnfsECgAAAAoAAAAEABwAZXhlY1VUCQADAOELXgDhC151eAsAAQQAAAAABAAAAAAjIS9iaW4vc2gKUEsBAh4DCgAAAAAAAAAhUACIWQsYAAAAGAAAAAUAGAAAAAAAAAAAAKSBAAAAAGEudHh0VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUAAAAAAAAAAAAAAAAAQAGAAAAAAAAAAQAO1BVwAAAGRpci9VVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwECHgMKAAAAAAAAACFQQqke3rgLAAC4CwAACQAYAAAAAAAAAAAApIGVAAAAZGlyL2IuYmluVVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUAAAAAAAAAAAAAAAAAUAGAAAAAAAAAAAAKSBkAwAAGVtcHR5VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhULr368EFAAAABQAAAAQAGAAAAAAAAAAAAP+hzwwAAGxpbmtVVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwECHgMKAAAAAAAAACFQgxbcjAEAAAABAAAABgAYAAAAAAAAAAAApIESDQAAw7wudHh0VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUB2d+wQKAAAACgAAAAQAGAAAAAAAAAAAAO2BUw0AAGV4ZWNVVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwUGAAAAAAcABwAPAgAAmw0AAAAA"
  },
  {
    "command": "TZ=UTC zip -q -y -0 -X out.zip -- a.txt dir dir/b.bin empty link ü.txt exec",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "hello hello hello hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "mtime": 1577836800,
        "linkname": "a.txt",
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "x"
      },
      {
        "name": "exec",
        "type": "file",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": "#!/bin/sh\n"
      }
    ],
    "archive": "UEsDBAoAAAAAAAAAIVAAiFkLGAAAABgAAAAFAAAAYS50eHRoZWxsbyBoZWxsbyBoZWxsbyBoZWxsbwpQSwMECgAAAAAAAAAhUAAAAAAAAAAAAAAAAAQAAABkaXIvUEsDBAoAAAAAAAAAIVBCqR7euAsAALgLAAAJAAAAZGlyL2IuYmluISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAUEsDBAoAAAAAAAAAIVAAAAAAAAAAAAAAAAAFAAAAZW1wdHlQSwMECgAAAAAAAAAhULr368EFAAAABQAAAAQAAABsaW5rYS50eHRQSwMECgAAAAAAAAAhUIMW3IwBAAAAAQAAAAYAAADDvC50eHR4UEsDBAoAAAAAAAAAIVAdnfsECgAAAAoAAAAEAAAAZXhlYyMhL2Jpbi9zaApQSwECHgMKAAAAAAAAACFQAIhZCxgAAAAYAAAABQAAAAAAAAAAAAAApIEAAAAAYS50eHRQSwECHgMKAAAAAAAAACFQAAAAAAAAAAAAAAAABAAAAAAAAAAAABAA7UE7AAAAZGlyL1BLAQIeAwoAAAAAAAAAIVBCqR7euAsAALgLAAAJAAAAAAAAAAAAAACkgV0AAABkaXIvYi5iaW5QSwECHgMKAAAAAAAAACFQAAAAAAAAAAAAAAAABQAAAAAAAAAAAAAApIE8DAAAZW1wdHlQSwECHgMKAAAAAAAAACFQuvfrwQUAAAAFAAAABAAAAAAAAAAAAAAA/6FfDAAAbGlua1BLAQIeAwoAAAAAAAAAIVCDFtyMAQAAAAEAAAAGAAAAAAAAAAAAAACkgYYMAADDvC50eHRQSwECHgMKAAAAAAAAACFQHZ37BAoAAAAKAAAABAAAAAAAAAAAAAAA7YGrDAAAZXhlY1BLBQYAAAAABwAHAGcBAADXDAAAAAA="
  },
  {
    "command": "TZ=UTC zip -q -y out.zip -- a.txt dir dir/b.bin empty link ü.txt exec",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "hello hello hello hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "mtime": 1577836800,
        "linkname": "a.txt",
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "x"
      },
      {
        "name": "exec",
        "type": "file",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": "#!/bin/sh\n"
      }
    ],
    "archive": "UEsDBBQAAAAIAAAAIVAAiFkLCwAAABgAAAAFABwAYS50eHRVVAkAAwDhC14A4QtedXgLAAEEAAAAAAQAAAAAy0jNyclXyEAnuQBQSwMECgAAAAAAAAAhUAAAAAAAAAAAAAAAAAQAHABkaXIvVVQJAAMA4QteAOELXnV4CwABBAAAAAAEAAAAAFBLAwQUAAAACAAAACFQQqke3nwAAAC4CwAACQAcAGRpci9iLmJpblVUCQADAOELXgDhC151eAsAAQQAAAAABAAAAABT1NA3s3XxDopMSM8rrVHVMbZy9PAPi03JLqpU0jQwt3P1CY5KzMgvq1XTNbF28gwIj0vNKa5S1jK0sHfzDYlOyiwor1PXM7Vx9gqMiE/LLalW0TaydHD3C41JziqsUBw1fdT0UdNHTR81fdT0UdNHTR81fdT0UdOpYDoAUEsDBAoAAAAAAAAAIVAAAAAAAAAAAAAAAAAFABwAZW1wdHlVVAkAAwDhC14A4QtedXgLAAEEAAAAAAQAAAAAUEsDBAoAAAAAAAAAIVC69+vBBQAAAAUAAAAEABwAbGlua1VUCQADAOELXgDhC151eAsAAQQAAAAABAAAAABhLnR4dFBLAwQKAAAAAAAAACFQgxbcjAEAAAABAAAABgAcAMO8LnR4dFVUCQADAOELXgDhC151eAsAAQQAAAAABAAAAAB4UEsDBAoAAAAAAAAAIVAdnfsECgAAAAoAAAAEABwAZXhlY1VUCQADAOELXgDhC151eAsAAQQAAAAABAAAAAAjIS9iaW4vc2gKUEsBAh4DFAAAAAgAAAAhUACIWQsLAAAAGAAAAAUAGAAAAAAAAQAAAKSBAAAAAGEudHh0VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUAAAAAAAAAAAAAAAAAQAGAAAAAAAAAAQAO1BSgAAAGRpci9VVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwECHgMUAAAACAAAACFQQqke3nwAAAC4CwAACQAYAAAAAAABAAAApIGIAAAAZGlyL2IuYmluVVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUAAAAAAAAAAAAAAAAAUAGAAAAAAAAAAAAKSBRwEAAGVtcHR5VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhULr368EFAAAABQAAAAQAGAAAAAAAAAAAAP+hhgEAAGxpbmtVVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwECHgMKAAAAAAAAACFQgxbcjAEAAAABAAAABgAYAAAAAAABAAAApIHJAQAAw7wudHh0VVQFAAMA4QtedXgLAAEEAAAAAAQAAAAAUEsBAh4DCgAAAAAAAAAhUB2d+wQKAAAACgAAAAQAGAAAAAAAAQAAAO2BCgIAAGV4ZWNVVAUAAwDhC151eAsAAQQAAAAABAAAAABQSwUGAAAAAAcABwAPAgAAUgIAAAAA"
  },
  {
    "command": "TZ=UTC zip -q -y -0 out.zip -- a.txt",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836801,
        "linkname": "",
        "data": "hi"
      }
    ],
    "archive": "UEsDBAoAAAAAAAEAIVCsKpPYAgAAAAIAAAAFABwAYS50eHRVVAkAAwHhC14B4QtedXgLAAEEAAAAAAQAAAAAaGlQSwECHgMKAAAAAAABACFQrCqT2AIAAAACAAAABQAYAAAAAAAAAAAApIEAAAAAYS50eHRVVAUAAwHhC151eAsAAQQAAAAABAAAAABQSwUGAAAAAAEAAQBLAAAAQQAAAAAA"
  },
  {
    "command": "TZ=UTC zip -q -y -0 -X out.zip -- a.txt",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "hi"
      }
    ],
    "archive": "UEsDBAoAAAAAAAAAIVCsKpPYAgAAAAIAAAAFAAAAYS50eHRoaVBLAQIeAwoAAAAAAAAAIVCsKpPYAgAAAAIAAAAFAAAAAAAAAAAAAACkgQAAAABhLnR4dFBLBQYAAAAAAQABADMAAAAlAAAAAAA="
  },
  {
    "command": "python3 (zipfile, unseekable) a.txt dir dir/b.bin empty link ü.txt exec",
    "entries": [
      {
        "name": "a.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "hello hello hello hello\n"
      },
      {
        "name": "dir",
        "type": "directory",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "dir/b.bin",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@GNU\\cjqx!(/6=DKRY`gnu|%,3:AHOV]dkry\")07>ELSZahov}&-4;BIPW^elsz#*18?FMT[bipw~'.5<CJQX_fmt{$+29@"
      },
      {
        "name": "empty",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": ""
      },
      {
        "name": "link",
        "type": "symlink",
        "mode": 511,
        "mtime": 1577836800,
        "linkname": "a.txt",
        "data": ""
      },
      {
        "name": "ü.txt",
        "type": "file",
        "mode": 420,
        "mtime": 1577836800,
        "linkname": "",
        "data": "x"
      },
      {
        "name": "exec",
        "type": "file",
        "mode": 493,
        "mtime": 1577836800,
        "linkname": "",
        "data": "#!/bin/sh\n"
      }
    ],
    "archive": "UEsDBBQACAAAAAAAIVAAAAAAAAAAAAAAAAAFAAAAYS50eHRoZWxsbyBoZWxsbyBoZWxsbyBoZWxsbwpQSwcIAIhZCxgAAAAYAAAAUEsDBBQACAAAAAAAIVAAAAAAAAAAAAAAAAAEAAAAZGlyL1BLBwgAAAAAAAAAAAAAAABQSwMEFAAIAAAAAAAhUAAAAAAAAAAAAAAAAAkAAABkaXIvYi5iaW4hKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBHTlVcY2pxeCEoLzY9REtSWWBnbnV8JSwzOkFIT1ZdZGtyeSIpMDc+RUxTWmFob3Z9Ji00O0JJUFdeZWxzeiMqMTg/Rk1UW2JpcHd+Jy41PENKUVhfZm10eyQrMjlAR05VXGNqcXghKC82PURLUllgZ251fCUsMzpBSE9WXWRrcnkiKTA3PkVMU1phaG92fSYtNDtCSVBXXmVsc3ojKjE4P0ZNVFtiaXB3ficuNTxDSlFYX2ZtdHskKzI5QEdOVVxjanF4ISgvNj1ES1JZYGdudXwlLDM6QUhPVl1ka3J5IikwNz5FTFNaYWhvdn0mLTQ7QklQV15lbHN6IyoxOD9GTVRbYmlwd34nLjU8Q0pRWF9mbXR7JCsyOUBQSwcIQqke3rgLAAC4CwAAUEsDBBQACAAAAAAAIVAAAAAAAAAAAAAAAAAFAAAAZW1wdHlQSwcIAAAAAAAAAAAAAAAAUEsDBBQACAAAAAAAIVAAAAAAAAAAAAAAAAAEAAAAbGlua2EudHh0UEsHCLr368EFAAAABQAAAFBLAwQUAAgIAAAAACFQAAAAAAAAAAAAAAAABgAAAMO8LnR4dHhQSwcIgxbcjAEAAAABAAAAUEsDBBQACAAAAAAAIVAAAAAAAAAAAAAAAAAEAAAAZXhlYyMhL2Jpbi9zaApQSwcIHZ37BAoAAAAKAAAAUEsBAhQDFAAIAAAAAAAhUACIWQsYAAAAGAAAAAUAAAAAAAAAAAAAAKSBAAAAAGEudHh0UEsBAhQDFAAIAAAAAAAhUAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAQAO1BSwAAAGRpci9QSwECFAMUAAgAAAAAACFQQqke3rgLAAC4CwAACQAAAAAAAAAAAAAApIF9AAAAZGlyL2IuYmluUEsBAhQDFAAIAAAAAAAhUAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAAAKSBbAwAAGVtcHR5UEsBAhQDFAAIAAAAAAAhULr368EFAAAABQAAAAQAAAAAAAAAAAAAAP+hnwwAAGxpbmtQSwECFAMUAAgIAAAAACFQgxbcjAEAAAABAAAABgAAAAAAAAAAAAAApIHWDAAAw7wudHh0UEsBAhQDFAAIAAAAAAAhUB2d+wQKAAAACgAAAAQAAAAAAAAAAAAAAO2BCw0AAGV4ZWNQSwUGAAAAAAcABwBnAQAARw0AAAAA"
  }
]
