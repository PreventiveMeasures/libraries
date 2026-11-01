// An image asset's width and height, as Metro reads them (its
// lib/imageSize.js): by the parser of the asset's type, else by the first of
// the others that reads the bytes, as Metro has long read assets by what they
// hold rather than what they are named. Mirrors Metro 0.87, MIT licensed,
// Copyright (c) Meta Platforms, Inc. and affiliates, whose parsers derive
// from image-size's (notice at the end).

import { Buffer } from 'node:buffer'

const MAX_SVG_HEADER_LENGTH = 64 * 1024
const KTX1 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
const KTX2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
const KTX_LE = Buffer.from([0x01, 0x02, 0x03, 0x04])
const KTX_BE = Buffer.from([0x04, 0x03, 0x02, 0x01])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The bytes as a Buffer over the same memory, whatever view they came in.
export const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))

const hasBytes = (content, offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= content.length && length <= content.length - offset
const startsWith = (content, prefix) => hasBytes(content, 0, prefix.length) && content.subarray(0, prefix.length).equals(prefix)
const ascii = (content, start, end) => content.toString('ascii', start, end)
const uint24le = (content, offset) => content[offset] + content[offset + 1] * 256 + content[offset + 2] * 65536

function parseBmp(content) {
  if (!hasBytes(content, 0, 26) || ascii(content, 0, 2) !== 'BM') return null
  const dibHeaderSize = content.readUInt32LE(14)
  if (dibHeaderSize === 12) return { width: content.readUInt16LE(18), height: content.readUInt16LE(20) }
  if (dibHeaderSize < 40) return null
  return { width: Math.abs(content.readInt32LE(18)), height: Math.abs(content.readInt32LE(22)) }
}

function parseGif(content) {
  if (!hasBytes(content, 0, 10) || !/^GIF8[79]a$/u.test(ascii(content, 0, 6))) return null
  return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) }
}

const isStandaloneJpegMarker = (marker) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
const isJpegStartOfFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

// The first start-of-frame segment's, walking the segments up to the scan.
function parseJpeg(content) {
  if (!hasBytes(content, 0, 4) || content[0] !== 0xff || content[1] !== 0xd8) return null
  let offset = 2
  while (offset < content.length) {
    while (offset < content.length && content[offset] === 0xff) offset++
    if (offset >= content.length) return null
    const marker = content[offset++]
    if (marker === 0x00) return null
    if (isStandaloneJpegMarker(marker)) {
      if (marker === 0xd9) return null
      continue
    }
    if (!hasBytes(content, offset, 2)) return null
    const length = content.readUInt16BE(offset)
    const end = offset + length
    if (length < 2 || end > content.length) return null
    if (isJpegStartOfFrame(marker)) return length < 7 ? null : { height: content.readUInt16BE(offset + 3), width: content.readUInt16BE(offset + 5) }
    if (marker === 0xda) return null
    offset = end
  }
  return null
}

function parseKtx(content) {
  if (hasBytes(content, 0, 64) && startsWith(content, KTX1)) {
    const endianness = content.subarray(12, 16)
    if (endianness.equals(KTX_LE)) return { width: content.readUInt32LE(36), height: content.readUInt32LE(40) }
    if (endianness.equals(KTX_BE)) return { width: content.readUInt32BE(36), height: content.readUInt32BE(40) }
    return null
  }
  if (hasBytes(content, 0, 80) && startsWith(content, KTX2)) return { width: content.readUInt32LE(20), height: content.readUInt32LE(24) }
  return null
}

// IHDR's, first; or, in Apple's CgBI PNG, right after the CgBI chunk.
function parsePng(content) {
  if (!hasBytes(content, 0, 24) || !startsWith(content, PNG)) return null
  const firstLength = content.readUInt32BE(8)
  const firstType = ascii(content, 12, 16)
  if (firstType === 'IHDR') return firstLength === 13 ? { width: content.readUInt32BE(16), height: content.readUInt32BE(20) } : null
  if (firstType !== 'CgBI') return null
  const ihdr = 8 + 12 + firstLength
  if (!hasBytes(content, ihdr, 24) || content.readUInt32BE(ihdr) !== 13 || ascii(content, ihdr + 4, ihdr + 8) !== 'IHDR') return null
  return { width: content.readUInt32BE(ihdr + 8), height: content.readUInt32BE(ihdr + 12) }
}

function parsePsd(content) {
  if (!hasBytes(content, 0, 22) || ascii(content, 0, 4) !== '8BPS' || (content.readUInt16BE(4) !== 1 && content.readUInt16BE(4) !== 2)) return null
  return { height: content.readUInt32BE(14), width: content.readUInt32BE(18) }
}

const SVG_UNITS = { in: 96, cm: 96 / 2.54, em: 16, ex: 8, mm: 96 / 2.54 / 10, pc: (96 / 72) * 12, pt: 96 / 72, px: 1 }

// The index of the `>` closing the tag that starts at `start`, past quoted
// attribute values.
function tagEnd(input, start) {
  let quote = null
  for (let index = start; index < input.length; index++) {
    const character = input[index]
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return null
}

function svgLength(value) {
  if (value === undefined || value.endsWith('%')) return null
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/iu.exec(value.trim())
  const factor = match === null ? undefined : match[2] === '' ? 1 : SVG_UNITS[match[2].toLowerCase()]
  return factor === undefined ? null : Math.round(Number(match[1]) * factor)
}

function svgViewBox(value) {
  const values = value?.trim().split(/[\s,]+/u).map(Number)
  if (values?.length !== 4 || !values.every((v) => Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) return null
  return { width: values[2], height: values[3] }
}

// The root <svg>'s width and height in px, the viewBox's aspect filling in
// one missing, else the viewBox's own.
function parseSvg(content) {
  const header = content.subarray(0, Math.min(content.length, MAX_SVG_HEADER_LENGTH)).toString('utf8')
  const start = /<svg(?:\s|>)/u.exec(header)?.index
  const end = start === undefined ? null : tagEnd(header, start)
  if (end === null) return null
  const attributes = {}
  for (const match of header.slice(start, end + 1).matchAll(/(?<![\w:-])(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3]
  }
  const width = svgLength(attributes.width)
  const height = svgLength(attributes.height)
  if (width !== null && height !== null) return { width, height }
  const viewBox = svgViewBox(attributes.viewbox)
  if (viewBox === null) return null
  if (width !== null) return { width, height: Math.floor(width / (viewBox.width / viewBox.height)) }
  if (height !== null) return { width: Math.floor(height * (viewBox.width / viewBox.height)), height }
  return viewBox
}

const tiff16 = (content, offset, bigEndian) => (bigEndian ? content.readUInt16BE(offset) : content.readUInt16LE(offset))
const tiff32 = (content, offset, bigEndian) => (bigEndian ? content.readUInt32BE(offset) : content.readUInt32LE(offset))

// A dimension tag's single SHORT or LONG value, else null.
function tiffDimension(content, entry, bigEndian) {
  if (tiff32(content, entry + 4, bigEndian) !== 1) return null
  const type = tiff16(content, entry + 2, bigEndian)
  if (type === 3) return tiff16(content, entry + 8, bigEndian)
  if (type === 4) return tiff32(content, entry + 8, bigEndian)
  return null
}

// ImageWidth's and ImageLength's, in the first IFD.
function parseTiff(content) {
  if (!hasBytes(content, 0, 8)) return null
  const order = ascii(content, 0, 2)
  const bigEndian = order === 'MM'
  if ((!bigEndian && order !== 'II') || tiff16(content, 2, bigEndian) !== 42) return null
  const ifd = tiff32(content, 4, bigEndian)
  if (!hasBytes(content, ifd, 2)) return null
  const count = tiff16(content, ifd, bigEndian)
  if (count > Math.floor((content.length - ifd - 2) / 12)) return null
  const found = {}
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12
    const tag = tiff16(content, entry, bigEndian)
    if (tag !== 256 && tag !== 257) continue
    const value = tiffDimension(content, entry, bigEndian)
    if (value === null) return null
    found[tag === 256 ? 'width' : 'height'] = value
  }
  return found.width !== undefined && found.height !== undefined ? { width: found.width, height: found.height } : null
}

// The first chunk of VP8X, VP8L or VP8 that says.
function parseWebp(content) {
  if (!hasBytes(content, 0, 20) || ascii(content, 0, 4) !== 'RIFF' || ascii(content, 8, 12) !== 'WEBP') return null
  let offset = 12
  while (hasBytes(content, offset, 8)) {
    const type = ascii(content, offset, offset + 4)
    const length = content.readUInt32LE(offset + 4)
    const data = offset + 8
    if (!hasBytes(content, data, length)) return null
    if (type === 'VP8X' && length >= 10) return { width: 1 + uint24le(content, data + 4), height: 1 + uint24le(content, data + 7) }
    if (type === 'VP8L' && length >= 5 && content[data] === 0x2f) {
      return {
        width: 1 + (((content[data + 2] & 0x3f) << 8) | content[data + 1]),
        height: 1 + (((content[data + 4] & 0x0f) << 10) | (content[data + 3] << 2) | ((content[data + 2] & 0xc0) >> 6)),
      }
    }
    if (type === 'VP8 ' && length >= 10 && content[data + 3] === 0x9d && content[data + 4] === 0x01 && content[data + 5] === 0x2a) {
      return { width: content.readUInt16LE(data + 6) & 0x3fff, height: content.readUInt16LE(data + 8) & 0x3fff }
    }
    const next = data + length + (length % 2)
    if (next <= offset) return null
    offset = next
  }
  return null
}

// Metro's image types, each by its parser; the parsers in the order Metro
// falls back through them.
const PARSERS = new Map([['bmp', parseBmp], ['gif', parseGif], ['jpeg', parseJpeg], ['jpg', parseJpeg], ['ktx', parseKtx], ['png', parsePng], ['psd', parsePsd], ['svg', parseSvg], ['tiff', parseTiff], ['webp', parseWebp]])
const FALLBACKS = [parseBmp, parseGif, parseJpeg, parseKtx, parsePng, parsePsd, parseSvg, parseTiff, parseWebp]

// Whether Metro takes an asset of `type` as an image, whose size it reads.
export const isAssetTypeAnImage = (type) => PARSERS.has(type)

const tryParse = (parser, content) => {
  try {
    return parser(content)
  } catch {
    return null
  }
}

// The width and height of the image `bytes` of an asset of `type` holds, by
// the parser for the type, else the first other that reads them; `filePath`
// names it in the error thrown where none does, or none reads a positive
// finite size.
export function imageDimensions(type, bytes, filePath) {
  const content = asBuffer(bytes)
  const own = PARSERS.get(type)
  const parsers = own === undefined ? FALLBACKS : [own, ...FALLBACKS.filter((parser) => parser !== own)]
  let dimensions = null
  for (const parser of parsers) {
    dimensions = tryParse(parser, content)
    if (dimensions !== null) break
  }
  const { width, height } = dimensions ?? {}
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) throw new Error(`Invalid ${type} image asset: ${filePath}`)
  return { width, height }
}

// image-size, from which these parsers derive (by way of Metro), is under the
// MIT License:
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
