import { deflateSync } from "zlib"

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Uncompressed RGBA, top row first. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1)
    raw[dest] = 0
    rgba.copy(raw, dest + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = deflateSync(raw)
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))])
}

function readFrame(data: Buffer, index: number): { area: number; bpp: number; png: Buffer } | null {
  const entry = 6 + index * 16
  if (entry + 16 > data.length) return null
  const dirWidth = data[entry] || 256
  const dirHeight = data[entry + 1] || 256
  const bytes = data.readUInt32LE(entry + 8)
  const offset = data.readUInt32LE(entry + 12)
  if (bytes < 8 || offset + bytes > data.length) return null
  const image = data.subarray(offset, offset + bytes)
  if (image.subarray(0, 8).equals(PNG_SIGNATURE)) return { area: dirWidth * dirHeight, bpp: 32, png: Buffer.from(image) }
  if (image.length < 40 || image.readUInt32LE(0) < 40) return null
  const width = image.readInt32LE(4)
  const dibHeight = image.readInt32LE(8)
  const bpp = image.readUInt16LE(14)
  const compression = image.readUInt32LE(16)
  if (width <= 0 || dibHeight <= 1 || dibHeight % 2 !== 0 || compression !== 0) return null
  if (bpp !== 32 && bpp !== 24 && bpp !== 8 && bpp !== 4 && bpp !== 1) return null
  const height = dibHeight / 2
  const colors = bpp <= 8 ? image.readUInt32LE(32) || 1 << bpp : 0
  const paletteAt = image.readUInt32LE(0)
  const xorAt = paletteAt + colors * 4
  const xorStride = Math.floor((width * bpp + 31) / 32) * 4
  const andStride = Math.floor((width + 31) / 32) * 4
  const andAt = xorAt + xorStride * height
  if (andAt + andStride * height > image.length) return null

  const rgba = Buffer.alloc(width * height * 4)
  let opaqueAlpha = false
  if (bpp === 32) {
    for (let i = 3; i < xorStride * height; i += 4) {
      if (image[xorAt + i]) {
        opaqueAlpha = true
        break
      }
    }
  }
  for (let y = 0; y < height; y++) {
    const stored = height - 1 - y
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      if (bpp === 32 || bpp === 24) {
        const pixel = xorAt + stored * xorStride + x * (bpp / 8)
        b = image[pixel]
        g = image[pixel + 1]
        r = image[pixel + 2]
        if (bpp === 32 && opaqueAlpha) a = image[pixel + 3]
      } else {
        const packed = image[xorAt + stored * xorStride + Math.floor((x * bpp) / 8)]
        const shift = 8 - bpp - ((x * bpp) % 8)
        const index = (packed >> shift) & ((1 << bpp) - 1)
        const color = paletteAt + index * 4
        if (color + 2 >= image.length) return null
        b = image[color]
        g = image[color + 1]
        r = image[color + 2]
      }
      if (!opaqueAlpha) {
        const mask = image[andAt + stored * andStride + (x >> 3)]
        if (mask & (0x80 >> (x & 7))) a = 0
      }
      const dest = (y * width + x) * 4
      rgba[dest] = r
      rgba[dest + 1] = g
      rgba[dest + 2] = b
      rgba[dest + 3] = a
    }
  }
  return { area: width * height, bpp, png: encodePng(width, height, rgba) }
}

/** The largest frame of an .ico, as PNG bytes. Returns null when the file is not a readable icon. */
export function pngFromIco(data: Buffer): Buffer | null {
  if (!Buffer.isBuffer(data) || data.length < 22 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return null
  const count = data.readUInt16LE(4)
  let best: { area: number; bpp: number; png: Buffer } | null = null
  for (let index = 0; index < count; index++) {
    const frame = readFrame(data, index)
    if (!frame) continue
    if (!best || frame.area > best.area || (frame.area === best.area && frame.bpp > best.bpp)) best = frame
  }
  return best ? best.png : null
}
