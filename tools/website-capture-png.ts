import * as zlib from 'node:zlib'

/** Largest PNG the capture writes. Mirrors `HOSTED_ARTIFACT_MAX_BYTES` in
 * `packages/hosted-store-service/src/config.ts`, the store's decoded artifact
 * ceiling; importing it here would pull in the postgres-store package, so a
 * unit test pins the equality instead. */
export const ARTIFACT_MAX_BYTES = 2.5 * 1024 * 1024

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export interface DecodedPng {
  width: number
  height: number
  colorType: number
  channels: number
  /** Unfiltered scanlines, top to bottom. */
  rows: Uint8Array[]
  /** Raw pre-IDAT ancillary chunks (length, type, data and CRC), kept verbatim. */
  ancillary: Uint8Array[]
}

export interface PngTile {
  /** 1-based position in the sequence. */
  index: number
  count: number
  top: number
  height: number
  bytes: Uint8Array
}

const unsupported = (why: string) => new Error(`unsupported PNG: ${why}`)

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.byteLength < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw unsupported('bad signature')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let header: { width: number; height: number; colorType: number } | undefined
  const idat: Uint8Array[] = []
  const ancillary: Uint8Array[] = []
  let ended = false
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw unsupported('truncated chunk')
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length
    if (end > bytes.byteLength) throw unsupported(`truncated ${type} chunk`)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      const width = view.getUint32(offset + 8)
      const height = view.getUint32(offset + 12)
      const [depth, colorType, , , interlace] = data.subarray(8, 13)
      if (depth !== 8) throw unsupported(`bit depth ${depth}`)
      if (interlace !== 0) throw unsupported('interlaced')
      if (!(colorType! in CHANNELS)) throw unsupported(`colour type ${colorType}`)
      header = { width, height, colorType: colorType! }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      ended = true
      break
    } else if (idat.length === 0 && type !== 'PLTE') {
      ancillary.push(bytes.slice(offset, end))
    }
    offset = end
  }
  if (!header) throw unsupported('no IHDR')
  if (!ended) throw unsupported('no IEND')
  const channels = CHANNELS[header.colorType]!
  const stride = header.width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.byteLength < (stride + 1) * header.height) throw unsupported('truncated image data')
  const rows: Uint8Array[] = []
  let previous: Uint8Array = new Uint8Array(stride)
  for (let y = 0; y < header.height; y++) {
    const start = y * (stride + 1)
    const filter = raw[start]!
    const line = raw.subarray(start + 1, start + 1 + stride)
    const row = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0
      const b = previous[i]!
      const c = i >= channels ? previous[i - channels]! : 0
      let predictor: number
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) predictor = paeth(a, b, c)
      else throw unsupported(`filter ${filter}`)
      row[i] = (line[i]! + predictor) & 0xff
    }
    rows.push(row)
    previous = row
  }
  return { ...header, channels, rows, ancillary }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

let crcTable: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32
  if (typeof native === 'function') return native(data) >>> 0
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))
  return out
}

export function encodePng(
  img: Pick<DecodedPng, 'width' | 'colorType' | 'ancillary'> & {
    rows: Uint8Array[]
  },
): Uint8Array {
  const channels = CHANNELS[img.colorType]
  if (!channels) throw unsupported(`colour type ${img.colorType}`)
  const stride = img.width * channels
  const filtered = new Uint8Array((stride + 1) * img.rows.length)
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride))
  let previous: Uint8Array = new Uint8Array(stride)
  img.rows.forEach((row, y) => {
    if (row.byteLength !== stride) throw new Error(`row ${y} is ${row.byteLength}, not ${stride}`)
    let best = 0
    let bestScore = Infinity
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter]!
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels]! : 0
        const b = previous[i]!
        const c = i >= channels ? previous[i - channels]! : 0
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c)
        const value = (row[i]! - predictor) & 0xff
        out[i] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) {
        bestScore = score
        best = filter
      }
    }
    const start = y * (stride + 1)
    filtered[start] = best
    filtered.set(candidates[best]!, start + 1)
    previous = row
  })
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, img.width)
  view.setUint32(4, img.rows.length)
  ihdr.set([8, img.colorType, 0, 0, 0], 8)
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...img.ancillary,
    chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
}

/** Cut a PNG over `maxBytes` into ordered full-width strips that each fit, or
 * return `null` when it already fits and should be left untouched. */
export function tilePng(bytes: Uint8Array, maxBytes: number): PngTile[] | null {
  if (bytes.byteLength <= maxBytes) return null
  const image = decodePng(bytes)
  for (let count = Math.max(2, Math.ceil(bytes.byteLength / maxBytes)); ; count++) {
    if (count > image.height) {
      throw new Error(`a one-row strip of a ${image.width}px-wide PNG exceeds ${maxBytes} bytes`)
    }
    const base = Math.floor(image.height / count)
    const extra = image.height % count
    const tiles: PngTile[] = []
    let top = 0
    for (let i = 0; i < count; i++) {
      const height = base + (i < extra ? 1 : 0)
      const encoded = encodePng({
        ...image,
        rows: image.rows.slice(top, top + height),
      })
      if (encoded.byteLength > maxBytes) break
      tiles.push({ index: i + 1, count, top, height, bytes: encoded })
      top += height
    }
    if (tiles.length === count) return tiles
  }
}
