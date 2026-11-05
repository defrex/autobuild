/** Synthetic ELF objects for tests of the shipped-Git stager. */

const BASE = 0x400000n

/** A minimal ELF64 object: one load segment over the whole file, plus the
 * interpreter, dynamic and note segments the options ask for. */
export function elf(
  options: {
    cls?: number
    data?: number
    machine?: number
    interpreter?: { path: string; size: number }
    needed?: string[]
    runpath?: string
    rpath?: string
    abiTag?: [number, number, number]
  } = {},
): Uint8Array {
  const strings: string[] = ['']
  const offsetOf = (value: string) => {
    let offset = 0
    for (const entry of strings) {
      if (entry === value) return offset
      offset += entry.length + 1
    }
    strings.push(value)
    return offset
  }
  const dynamic: [bigint, bigint][] = []
  for (const name of options.needed ?? []) dynamic.push([1n, BigInt(offsetOf(name))])
  if (options.rpath !== undefined) dynamic.push([15n, BigInt(offsetOf(options.rpath))])
  if (options.runpath !== undefined) dynamic.push([29n, BigInt(offsetOf(options.runpath))])
  const strtab = new TextEncoder().encode(strings.map((entry) => `${entry}\0`).join(''))
  const segments: { type: number; bytes: Uint8Array; align?: number }[] = []
  if (options.interpreter) {
    const bytes = new Uint8Array(options.interpreter.size)
    bytes.set(new TextEncoder().encode(options.interpreter.path))
    segments.push({ type: 3, bytes })
  }
  const program = 1 + segments.length + (dynamic.length ? 1 : 0) + (options.abiTag ? 1 : 0)
  let cursor = 64 + program * 56
  const placed: { type: number; offset: number; size: number; align: number }[] = []
  const chunks: [number, Uint8Array][] = []
  for (const segment of segments) {
    placed.push({ type: segment.type, offset: cursor, size: segment.bytes.length, align: 1 })
    chunks.push([cursor, segment.bytes])
    cursor += segment.bytes.length
  }
  if (dynamic.length) {
    const strtabOffset = cursor
    chunks.push([strtabOffset, strtab])
    cursor += strtab.length
    cursor = Math.ceil(cursor / 8) * 8
    const table = new Uint8Array((dynamic.length + 2) * 16)
    const view = new DataView(table.buffer)
    ;[
      ...dynamic,
      [5n, BASE + BigInt(strtabOffset)] as [bigint, bigint],
      [0n, 0n] as [bigint, bigint],
    ].forEach(([tag, value], index) => {
      view.setBigInt64(index * 16, tag, true)
      view.setBigUint64(index * 16 + 8, value, true)
    })
    placed.push({ type: 2, offset: cursor, size: table.length, align: 8 })
    chunks.push([cursor, table])
    cursor += table.length
  }
  if (options.abiTag) {
    const note = new Uint8Array(32)
    const view = new DataView(note.buffer)
    view.setUint32(0, 4, true)
    view.setUint32(4, 16, true)
    view.setUint32(8, 1, true)
    note.set(new TextEncoder().encode('GNU\0'), 12)
    view.setUint32(16, 0, true)
    options.abiTag.forEach((part, index) => {
      view.setUint32(20 + index * 4, part, true)
    })
    placed.push({ type: 4, offset: cursor, size: note.length, align: 4 })
    chunks.push([cursor, note])
    cursor += note.length
  }
  const bytes = new Uint8Array(cursor)
  const view = new DataView(bytes.buffer)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, options.cls ?? 2, options.data ?? 1, 1])
  view.setUint16(18, options.machine ?? 62, true)
  view.setBigUint64(32, 64n, true)
  view.setUint16(54, 56, true)
  view.setUint16(56, program, true)
  const headers = [{ type: 1, offset: 0, size: cursor, align: 0x1000 }, ...placed]
  headers.forEach((header, index) => {
    const at = 64 + index * 56
    view.setUint32(at, header.type, true)
    view.setBigUint64(at + 8, BigInt(header.offset), true)
    view.setBigUint64(at + 16, BASE + BigInt(header.offset), true)
    view.setBigUint64(at + 32, BigInt(header.size), true)
    view.setBigUint64(at + 40, BigInt(header.size), true)
    view.setBigUint64(at + 48, BigInt(header.align), true)
  })
  for (const [offset, chunk] of chunks) bytes.set(chunk, offset)
  return bytes
}
