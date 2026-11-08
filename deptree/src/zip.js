// The central directory of a zip the archive reader has read whole, so that
// every record is where it says: what the reader does not hand out of each
// entry, as the program that would extract the zip reads it -- the system it
// was made on, the version it needs, its flags and attributes, and its extra
// field as stored -- in the order the reader lists the entries.

const END = 0x06054b50
const CENTRAL = 0x02014b50

export function centralRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (view.getUint32(end, true) !== END || end + 22 + view.getUint16(end + 20, true) !== bytes.length) end--
  const records = []
  let at = view.getUint32(end + 16, true)
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('unreachable: a central record where the archive reader found none')
    const [nameLength, extraLength, commentLength] = [at + 28, at + 30, at + 32].map((field) => view.getUint16(field, true))
    records.push({
      system: view.getUint8(at + 5),
      version: view.getUint16(at + 6, true),
      flags: view.getUint16(at + 8, true),
      attributes: view.getUint32(at + 38, true),
      name: bytes.subarray(at + 46, at + 46 + nameLength),
      extra: bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return records
}

// The extra fields of a record, each its id and its body, which the archive
// reader has checked tile the field.
export function extraFields(extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  const fields = []
  for (let pos = 0; pos < extra.length;) {
    const size = view.getUint16(pos + 2, true)
    fields.push({ id: view.getUint16(pos, true), body: extra.subarray(pos + 4, pos + 4 + size) })
    pos += 4 + size
  }
  return fields
}
