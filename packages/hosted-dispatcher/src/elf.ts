/**
 * Just enough ELF to stage a self-contained Git: the program interpreter, the
 * dynamic section's library names and search paths, and glibc's ABI note.
 * Only ELF64 little-endian x86_64 objects are accepted — the one platform the
 * hosted dispatcher ships Git for.
 */

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const PT_NOTE = 4
const DT_NULL = 0n
const DT_NEEDED = 1n
const DT_STRTAB = 5n
const DT_RPATH = 15n
const DT_RUNPATH = 29n
const NT_GNU_ABI_TAG = 1
export const EM_X86_64 = 62

export interface ElfInfo {
  /** Always 64 for an accepted object. */
  class: 64
  machine: number
  /** The `PT_INTERP` segment, when the object names a program loader. */
  interpreter?: { path: string; offset: number; size: number }
  needed: string[]
  rpath: string[]
  runpath: string[]
  /** glibc's `NT_GNU_ABI_TAG`: the oldest Linux kernel the object supports. */
  abiTag?: { os: number; kernel: string }
}

export class ElfError extends Error {}

/** Whether `bytes` starts with the ELF magic number. */
export function isElf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
}

interface ProgramHeader {
  type: number
  offset: number
  vaddr: bigint
  filesz: number
  align: number
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function headers(bytes: Uint8Array): { machine: number; program: ProgramHeader[] } {
  if (!isElf(bytes)) throw new ElfError('not an ELF object')
  if (bytes.length < 64) throw new ElfError('truncated ELF header')
  if (bytes[4] !== 2) throw new ElfError('not a 64-bit ELF object')
  if (bytes[5] !== 1) throw new ElfError('not a little-endian ELF object')
  const data = view(bytes)
  const machine = data.getUint16(18, true)
  if (machine !== EM_X86_64) throw new ElfError(`ELF machine ${machine} is not x86_64`)
  const phoff = Number(data.getBigUint64(32, true))
  const phentsize = data.getUint16(54, true)
  const phnum = data.getUint16(56, true)
  if (phoff + phentsize * phnum > bytes.length) throw new ElfError('truncated program headers')
  const program: ProgramHeader[] = []
  for (let index = 0; index < phnum; index++) {
    const at = phoff + index * phentsize
    program.push({
      type: data.getUint32(at, true),
      offset: Number(data.getBigUint64(at + 8, true)),
      vaddr: data.getBigUint64(at + 16, true),
      filesz: Number(data.getBigUint64(at + 32, true)),
      align: Number(data.getBigUint64(at + 48, true)),
    })
  }
  return { machine, program }
}

function cString(bytes: Uint8Array, start: number, end = bytes.length): string {
  let stop = start
  while (stop < end && bytes[stop] !== 0) stop++
  return new TextDecoder().decode(bytes.subarray(start, stop))
}

/** File offset of a virtual address, through the load segment mapping it. */
function fileOffset(program: ProgramHeader[], address: bigint): number {
  for (const segment of program) {
    if (segment.type !== PT_LOAD) continue
    if (address >= segment.vaddr && address < segment.vaddr + BigInt(segment.filesz))
      return segment.offset + Number(address - segment.vaddr)
  }
  throw new ElfError(`address 0x${address.toString(16)} is not mapped by a load segment`)
}

function splitPaths(value: string): string[] {
  return value.split(':').filter((entry) => entry !== '')
}

export function readElf(bytes: Uint8Array): ElfInfo {
  const { machine, program } = headers(bytes)
  const data = view(bytes)
  const info: ElfInfo = { class: 64, machine, needed: [], rpath: [], runpath: [] }
  for (const segment of program) {
    if (segment.type === PT_INTERP) {
      if (segment.offset + segment.filesz > bytes.length)
        throw new ElfError('truncated interpreter segment')
      info.interpreter = {
        path: cString(bytes, segment.offset, segment.offset + segment.filesz),
        offset: segment.offset,
        size: segment.filesz,
      }
    }
    if (segment.type === PT_DYNAMIC) {
      const entries: [bigint, bigint][] = []
      for (let at = segment.offset; at + 16 <= segment.offset + segment.filesz; at += 16) {
        const tag = data.getBigInt64(at, true)
        if (tag === DT_NULL) break
        entries.push([tag, data.getBigUint64(at + 8, true)])
      }
      const strtab = entries.find(([tag]) => tag === DT_STRTAB)?.[1]
      if (strtab === undefined) continue
      const base = fileOffset(program, strtab)
      for (const [tag, value] of entries) {
        const text = () => cString(bytes, base + Number(value))
        if (tag === DT_NEEDED) info.needed.push(text())
        if (tag === DT_RPATH) info.rpath.push(...splitPaths(text()))
        if (tag === DT_RUNPATH) info.runpath.push(...splitPaths(text()))
      }
    }
    if (segment.type === PT_NOTE) {
      const align = segment.align === 8 ? 8 : 4
      const pad = (n: number) => Math.ceil(n / align) * align
      let at = segment.offset
      const end = segment.offset + segment.filesz
      while (at + 12 <= end) {
        const namesz = data.getUint32(at, true)
        const descsz = data.getUint32(at + 4, true)
        const type = data.getUint32(at + 8, true)
        const name = cString(bytes, at + 12, at + 12 + namesz)
        const desc = at + 12 + pad(namesz)
        if (name === 'GNU' && type === NT_GNU_ABI_TAG && descsz >= 16 && desc + 16 <= end) {
          info.abiTag = {
            os: data.getUint32(desc, true),
            kernel: [4, 8, 12].map((offset) => data.getUint32(desc + offset, true)).join('.'),
          }
        }
        at = desc + pad(descsz)
      }
    }
  }
  return info
}

/** Point the object's program loader at `path`, in place. The new path must
 * fit the existing `PT_INTERP` segment with its NUL terminator; the rest of
 * the segment is NUL-padded, which the kernel accepts. Returns whether the
 * object had an interpreter to rewrite (shared libraries have none). */
export function rewriteInterpreter(bytes: Uint8Array, path: string): boolean {
  const interpreter = readElf(bytes).interpreter
  if (interpreter === undefined) return false
  const encoded = new TextEncoder().encode(path)
  if (encoded.length + 1 > interpreter.size)
    throw new ElfError(
      `interpreter ${JSON.stringify(path)} needs ${encoded.length + 1} bytes but the ` +
        `segment holds ${interpreter.size}`,
    )
  bytes.fill(0, interpreter.offset, interpreter.offset + interpreter.size)
  bytes.set(encoded, interpreter.offset)
  return true
}
