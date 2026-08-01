import fs from 'fs';

export interface ImageDims {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';
}

export const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// JPEG start-of-frame markers carry the dimensions. 0xC4 (define Huffman
// table), 0xC8 (JPEG extension) and 0xCC (define arithmetic coding) sit in
// the same numeric range but are not frame headers.
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function jpegDims(b: Buffer): ImageDims | null {
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    // Padding, and standalone markers that carry no length field.
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd9) {
      off += 2;
      continue;
    }
    if (isSofMarker(marker)) {
      return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7), format: 'jpeg' };
    }
    const segLen = b.readUInt16BE(off + 2);
    if (segLen < 2) return null;
    off += 2 + segLen;
  }
  return null;
}

function webpDims(b: Buffer): ImageDims | null {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: (b.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (b.readUIntLE(27, 3) & 0xffffff) + 1,
      format: 'webp',
    };
  }
  if (chunk === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
  }
  return null;
}

/**
 * Read pixel dimensions straight out of an image header. Returns null for
 * anything unrecognised or unreadable — callers treat that as "no opinion"
 * rather than a failure, since this only ever gates a warning.
 *
 * Deliberately dependency-free: the agent containers ship no image library
 * (python3-pil is listed in some group configs but is not importable), and a
 * header parse is enough to get width and height.
 */
export function readImageDims(filePath: string): ImageDims | null {
  let b: Buffer;
  try {
    b = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (b.length < 26) return null;

  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) return jpegDims(b);
  if (b.toString('ascii', 0, 3) === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return webpDims(b);
  }
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)), format: 'bmp' };
  }
  return null;
}
