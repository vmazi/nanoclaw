import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { IMAGE_PATH_RE, readImageDims } from './image-dims.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-dims-'));

function write(name: string, b: Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, b);
  return p;
}

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt8(0x89, 0);
  b.write('PNG\r\n\x1a\n', 1, 'ascii');
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, a JFIF APP0 segment to make sure segment skipping works, then SOF0.
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

describe('readImageDims', () => {
  it('reads PNG dimensions', () => {
    expect(readImageDims(write('a.png', png(2400, 1080)))).toEqual({
      width: 2400,
      height: 1080,
      format: 'png',
    });
  });

  it('reads JPEG dimensions past a leading APP0 segment', () => {
    expect(readImageDims(write('a.jpg', jpeg(1179, 937)))).toEqual({
      width: 1179,
      height: 937,
      format: 'jpeg',
    });
  });

  it('reads GIF dimensions', () => {
    const b = Buffer.alloc(32);
    b.write('GIF89a', 0, 'ascii');
    b.writeUInt16LE(640, 6);
    b.writeUInt16LE(480, 8);
    expect(readImageDims(write('a.gif', b))).toEqual({ width: 640, height: 480, format: 'gif' });
  });

  it('returns null for a missing file, a non-image, and a truncated header', () => {
    expect(readImageDims(path.join(tmp, 'nope.png'))).toBeNull();
    expect(readImageDims(write('a.txt', Buffer.from('hello world, not an image at all')))).toBeNull();
    expect(readImageDims(write('short.png', Buffer.from([0x89, 0x50])))).toBeNull();
  });
});

describe('IMAGE_PATH_RE', () => {
  it('matches image extensions case-insensitively and ignores others', () => {
    for (const p of ['/tmp/front.png', '/a/b.JPEG', 'c.jpg', 'd.webp', 'e.BMP', 'f.gif']) {
      expect(IMAGE_PATH_RE.test(p)).toBe(true);
    }
    for (const p of ['/tmp/notes.md', '/a/b.png.txt', 'script.ts']) {
      expect(IMAGE_PATH_RE.test(p)).toBe(false);
    }
  });
});
