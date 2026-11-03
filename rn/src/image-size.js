// Image sizes as Metro 0.87's lib/imageSize.js reads them (MIT, Copyright (c) Meta Platforms,
// Inc. and affiliates), its parsers derived from image-size's (MIT, notice at the end). A parser
// answers null, or throws reading past the end, for bytes not of its format.

import { Buffer } from 'node:buffer'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const KTX1 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
const KTX2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])

// As Metro reads a tag: ASCII drops each byte's high bit.
const ascii = (content, start, end) => content.toString('ascii', start, end)
const startsWith = (content, prefix) => content.subarray(0, prefix.length).equals(prefix)

function parseBmp(content) {
  if (content.length < 26 || ascii(content, 0, 2) !== 'BM') return null
  const header = content.readUInt32LE(14)
  if (header === 12) return { width: content.readUInt16LE(18), height: content.readUInt16LE(20) }
  return header < 40 ? null : { width: Math.abs(content.readInt32LE(18)), height: Math.abs(content.readInt32LE(22)) }
}

function parseGif(content) {
  if (content.length < 10 || !/^GIF8[79]a$/u.test(ascii(content, 0, 6))) return null
  return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) }
}

// The first start-of-frame segment's.
function parseJpeg(content) {
  if (content.length < 4 || content[0] !== 0xff || content[1] !== 0xd8) return null
  let offset = 2
  while (offset < content.length) {
    while (content[offset] === 0xff) offset++
    const marker = content[offset++]
    // No marker, the image's end, or the start of its data.
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return null
    // A marker without a segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    const length = content.readUInt16BE(offset)
    if (length < 2 || offset + length > content.length) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return length < 7 ? null : { width: content.readUInt16BE(offset + 5), height: content.readUInt16BE(offset + 3) }
    offset += length
  }
  return null
}

function parseKtx(content) {
  if (content.length >= 64 && startsWith(content, KTX1)) {
    const endianness = content.readUInt32LE(12)
    if (endianness === 0x04030201) return { width: content.readUInt32LE(36), height: content.readUInt32LE(40) }
    if (endianness === 0x01020304) return { width: content.readUInt32BE(36), height: content.readUInt32BE(40) }
    return null
  }
  if (content.length >= 80 && startsWith(content, KTX2)) return { width: content.readUInt32LE(20), height: content.readUInt32LE(24) }
  return null
}

// IHDR, first or after Apple's CgBI chunk.
function parsePng(content) {
  if (content.length < 24 || !startsWith(content, PNG)) return null
  let ihdr = 8
  if (ascii(content, 12, 16) === 'CgBI') {
    ihdr += 12 + content.readUInt32BE(8)
    if (content.length < ihdr + 24) return null
  }
  if (content.readUInt32BE(ihdr) !== 13 || ascii(content, ihdr + 4, ihdr + 8) !== 'IHDR') return null
  return { width: content.readUInt32BE(ihdr + 8), height: content.readUInt32BE(ihdr + 12) }
}

function parsePsd(content) {
  if (content.length < 22 || ascii(content, 0, 4) !== '8BPS' || ![1, 2].includes(content.readUInt16BE(4))) return null
  return { width: content.readUInt32BE(18), height: content.readUInt32BE(14) }
}

const SVG_UNITS = { '': 1, in: 96, cm: 96 / 2.54, em: 16, ex: 8, mm: 96 / 2.54 / 10, pc: (96 / 72) * 12, pt: 96 / 72, px: 1 }

function svgLength(value = '') {
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/iu.exec(value.trim())
  const factor = match === null ? undefined : SVG_UNITS[match[2].toLowerCase()]
  return factor === undefined ? null : Math.round(Number(match[1]) * factor)
}

function svgViewBox(value = '') {
  const values = value.trim().split(/[\s,]+/u).map(Number)
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0 ? { width: values[2], height: values[3] } : null
}

// By the root tag's width and height, else its viewBox: scaled to the one given, else as it is.
function parseSvg(content) {
  const header = content.toString('utf8', 0, 64 * 1024)
  const start = header.search(/<svg[\s>]/u)
  // Through the `>` closing the tag, past quoted values.
  const tag = start === -1 ? undefined : /^(?:[^"'>]|"[^"]*"|'[^']*')*>/u.exec(header.slice(start))?.[0]
  if (tag === undefined) return null
  const attributes = Object.fromEntries(tag.matchAll(/(?<![\w:-])(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu).map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]))
  const width = svgLength(attributes.width)
  const height = svgLength(attributes.height)
  if (width !== null && height !== null) return { width, height }
  const viewBox = svgViewBox(attributes.viewbox)
  if (viewBox === null) return null
  const ratio = viewBox.width / viewBox.height
  if (width !== null) return { width, height: Math.floor(width / ratio) }
  if (height !== null) return { width: Math.floor(height * ratio), height }
  return viewBox
}

// The first IFD's ImageWidth and ImageLength, each a single SHORT or LONG.
function parseTiff(content) {
  const order = ascii(content, 0, 2)
  if (content.length < 8 || (order !== 'II' && order !== 'MM')) return null
  const view = new DataView(content.buffer, content.byteOffset, content.length)
  const little = order === 'II'
  const u16 = (offset) => view.getUint16(offset, little)
  const u32 = (offset) => view.getUint32(offset, little)
  if (u16(2) !== 42) return null
  const entries = u32(4) + 2
  const end = entries + u16(entries - 2) * 12
  if (end > content.length) return null
  const size = {}
  for (let entry = entries; entry < end; entry += 12) {
    const tag = u16(entry)
    if (tag !== 256 && tag !== 257) continue
    const type = u16(entry + 2)
    if (u32(entry + 4) !== 1 || (type !== 3 && type !== 4)) return null
    size[tag === 256 ? 'width' : 'height'] = type === 3 ? u16(entry + 8) : u32(entry + 8)
  }
  return size.width !== undefined && size.height !== undefined ? size : null
}

// The first VP8X, VP8L or VP8 chunk's.
function parseWebp(content) {
  if (content.length < 20 || ascii(content, 0, 4) !== 'RIFF' || ascii(content, 8, 12) !== 'WEBP') return null
  let offset = 12
  while (offset + 8 <= content.length) {
    const type = ascii(content, offset, offset + 4)
    const length = content.readUInt32LE(offset + 4)
    const data = offset + 8
    if (data + length > content.length) return null
    if (type === 'VP8X' && length >= 10) return { width: 1 + content.readUIntLE(data + 4, 3), height: 1 + content.readUIntLE(data + 7, 3) }
    if (type === 'VP8L' && length >= 5 && content[data] === 0x2f) {
      return {
        width: 1 + (((content[data + 2] & 0x3f) << 8) | content[data + 1]),
        height: 1 + (((content[data + 4] & 0x0f) << 10) | (content[data + 3] << 2) | ((content[data + 2] & 0xc0) >> 6)),
      }
    }
    if (type === 'VP8 ' && length >= 10 && content.readUIntBE(data + 3, 3) === 0x9d012a) return { width: content.readUInt16LE(data + 6) & 0x3fff, height: content.readUInt16LE(data + 8) & 0x3fff }
    // Chunks are padded to an even length.
    offset = data + length + (length % 2)
  }
  return null
}

// Metro's image types, in the order it falls back through their parsers.
const PARSERS = new Map([['bmp', parseBmp], ['gif', parseGif], ['jpeg', parseJpeg], ['jpg', parseJpeg], ['ktx', parseKtx], ['png', parsePng], ['psd', parsePsd], ['svg', parseSvg], ['tiff', parseTiff], ['webp', parseWebp]])

const tryParse = (parser, content) => {
  try {
    return parser(content)
  } catch {
    return null
  }
}

// Metro's getAssetSize: null for a type that is no image's, else by the type's parser, then by
// the first other that reads the bytes.
export function imageSize(type, bytes, filePath) {
  if (!PARSERS.has(type)) return null
  if (bytes.length === 0) throw new Error(`Image asset \`${filePath}\` cannot be an empty file.`)
  const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parsers = new Set([PARSERS.get(type), ...PARSERS.values()])
  const { width, height } = parsers.values().map((parser) => tryParse(parser, content)).find((size) => size !== null) ?? {}
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) throw new Error(`Invalid ${type} image asset: ${filePath}`)
  return { width, height }
}

// image-size is under the MIT License:
//
// Copyright (c) 2013-Present Aditya Yadav, http://netroy.in
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
