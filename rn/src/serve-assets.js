// GET /assets/<path>@<scale>x.<type>?platform= as Metro answers it
// (Server._processSingleAssetRequest, Assets.getAsset; MIT, Copyright (c)
// Meta Platforms, Inc. and affiliates), but only of an asset a bundle the
// server built has: the file of the scale asked for, else the next up, else
// the largest; a byte range of it where asked, as AVPlayer asks for video.

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

// `rawPath`: the request's path, `..` segments kept, as assetData's
// httpServerLocation keeps them. -> { status, headers, body }.
export function assetResponse(rawPath, { platform = null, range, find, host = diskHost }) {
  let rel
  try {
    rel = rawPath.slice('/assets/'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return { status: 400, headers: {}, body: 'rn-serve: bad asset path\n' }
  }
  const asked = parseAssetPath(rel, platform)
  const dir = posix.dirname(rel)
  const location = dir.startsWith('..') ? `/assets/${dir}` : posix.join('/assets', dir)
  const data = asked === null ? null : find(location, asked.name, asked.type)
  const missing = { status: 404, headers: {}, body: 'rn-serve: no such asset in a bundle served\n' }
  if (data === null) return missing
  let file
  let bytes
  try {
    const { files, scales } = assetRecord(join(data.fileSystemLocation, `${data.name}.${data.type}`), { platform, host })
    const at = scales.findIndex((scale) => scale >= asked.resolution)
    file = files[at === -1 ? files.length - 1 : at]
    bytes = host.readFile(file)
  } catch {
    // Gone since the build.
    return missing
  }
  const headers = { 'Content-Type': TYPES.get(extname(file).slice(1).toLowerCase()) ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  return { status: 200, headers, body: bytes, ...ranged(bytes, range, headers) }
}

function ranged(bytes, range, headers) {
  const match = RANGE.exec(range ?? '')
  if (match === null || (match[1] === '' && match[2] === '')) return {}
  const size = bytes.length
  const [start, end] = match[1] === '' ? [Math.max(size - Number(match[2]), 0), size - 1] : [Number(match[1]), match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)]
  if (start > end || start >= size) return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` }, body: '' }
  return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` }, body: bytes.subarray(start, end + 1) }
}
