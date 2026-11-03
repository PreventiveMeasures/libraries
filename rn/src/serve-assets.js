// GET /assets/<path>@<scale>x.<type>?platform= as Metro answers it (Server._processSingleAssetRequest;
// MIT, Copyright (c) Meta Platforms, Inc. and affiliates), but only for assets of bundles it built.
// Serves the scale asked for, else the next up, else the largest; and byte ranges, as AVPlayer asks.

import { extname, join, posix } from 'node:path'

import { assetRecord, parseAssetPath } from './assets.js'
import { diskHost } from './defaults.js'

const TYPES = new Map(Object.entries({
  bmp: 'image/bmp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', psd: 'image/vnd.adobe.photoshop', svg: 'image/svg+xml', webp: 'image/webp', xml: 'application/xml',
  m4v: 'video/x-m4v', mov: 'video/quicktime', mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', webm: 'video/webm',
  aac: 'audio/aac', aiff: 'audio/aiff', caf: 'audio/x-caf', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  html: 'text/html; charset=utf-8', pdf: 'application/pdf', yaml: 'application/yaml', yml: 'application/yaml',
  otf: 'font/otf', ttf: 'font/ttf', zip: 'application/zip',
}))
const RANGE = /^bytes=(\d*)-(\d*)$/u
const MISSING = { status: 404, headers: {}, body: 'rn-serve: no such asset in a bundle served\n' }

// `rawPath` keeps its `..` segments, as assetData's httpServerLocation does.
export function assetResponse(rawPath, { platform, range, find }) {
  let rel
  try {
    rel = rawPath.slice('/assets/'.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return { status: 400, headers: {}, body: 'rn-serve: bad asset path\n' }
  }
  const asked = parseAssetPath(rel, platform)
  if (asked === null) return MISSING
  const dir = posix.dirname(rel)
  const data = find(dir.startsWith('..') ? `/assets/${dir}` : posix.join('/assets', dir), asked.name, asked.type)
  if (data === null) return MISSING
  let file
  let bytes
  try {
    const { files, scales } = assetRecord(join(data.fileSystemLocation, `${data.name}.${data.type}`), { platform, host: diskHost })
    // The first scale at least as large as asked, else (-1) the largest.
    file = files.at(scales.findIndex((scale) => scale >= asked.resolution))
    bytes = diskHost.readFile(file)
  } catch {
    // Gone since the build.
    return MISSING
  }
  const headers = { 'Content-Type': TYPES.get(extname(file).slice(1).toLowerCase()) ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  return { status: 200, headers, body: bytes, ...ranged(bytes, range, headers) }
}

function ranged(bytes, range, headers) {
  const [, from, to] = RANGE.exec(range ?? '') ?? []
  if (!from && !to) return {}
  const size = bytes.length
  const [start, end] = from === '' ? [Math.max(size - Number(to), 0), size - 1] : [Number(from), to === '' ? size - 1 : Math.min(Number(to), size - 1)]
  if (start > end || start >= size) return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` }, body: '' }
  return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` }, body: bytes.subarray(start, end + 1) }
}
