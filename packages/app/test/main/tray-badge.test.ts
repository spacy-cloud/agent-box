import { describe, expect, it } from 'vitest';
import { badgeLabel, drawCountBadge } from '../../src/main/tray-badge';

const SIZE = 32;
const blank = () => Buffer.alloc(SIZE * SIZE * 4);
const px = (b: Buffer, x: number, y: number) => {
  const i = (y * SIZE + x) * 4;
  return { b: b[i]!, g: b[i + 1]!, r: b[i + 2]!, a: b[i + 3]! };
};
const count = (b: Buffer, pred: (p: ReturnType<typeof px>) => boolean) => {
  let n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (pred(px(b, x, y))) n++;
  return n;
};
const white = (p: { r: number; g: number; b: number; a: number }) =>
  p.r === 255 && p.g === 255 && p.b === 255 && p.a === 255;
const red = (p: { r: number; g: number; b: number; a: number }) =>
  p.r === 0xd9 && p.g === 0x30 && p.b === 0x25 && p.a === 255;

describe('tray count badge', () => {
  it('labels 1..9 and 9+ above', () => {
    expect([0, 1, 9, 10, 99].map(badgeLabel)).toEqual(['0', '1', '9', '9+', '9+']);
  });

  it('a count of 0 leaves the icon as it is', () => {
    const base = blank();
    expect(drawCountBadge(base, SIZE, 0).equals(base)).toBe(true);
  });

  it('draws a red disc with white digits in the lower right corner only', () => {
    const base = blank();
    const out = drawCountBadge(base, SIZE, 3);
    expect(out).not.toBe(base);
    expect(base.every((v) => v === 0)).toBe(true); // the input is not modified
    expect(px(out, 0, 0).a).toBe(0);
    expect(px(out, 2, 20).a).toBe(0);
    expect(count(out, red)).toBeGreaterThan(150);
    expect(count(out, white)).toBeGreaterThan(15);
    // every changed pixel lies in the lower right quarter
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) if (px(out, x, y).a > 0) expect(x >= 12 && y >= 12).toBe(true);
  });

  it('different counts look different, 9+ has a plus sign', () => {
    const one = drawCountBadge(blank(), SIZE, 1);
    const two = drawCountBadge(blank(), SIZE, 2);
    const many = drawCountBadge(blank(), SIZE, 12);
    expect(one.equals(two)).toBe(false);
    expect(drawCountBadge(blank(), SIZE, 10).equals(many)).toBe(true); // same label "9+"
    expect(many.equals(drawCountBadge(blank(), SIZE, 9))).toBe(false);
  });

  it('keeps the drawing inside a smaller or damaged bitmap', () => {
    expect(() => drawCountBadge(Buffer.alloc(16 * 16 * 4), 16, 5)).not.toThrow();
    const tiny = Buffer.alloc(8);
    expect(drawCountBadge(tiny, 32, 5).equals(tiny)).toBe(true);
  });
});
