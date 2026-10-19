/**
 * Draws the number of pending approvals onto the tray icon: a red disc with the count (`9+` above nine) in the
 * lower right corner. Works on a raw 32-bit BGRA bitmap (the layout of Electron's `NativeImage.toBitmap()` on
 * little-endian machines), so it needs no canvas and no Electron and is easy to test.
 */

/** 3 x 5 digits and `+`; each row is 3 bits, most significant bit = left pixel. */
const GLYPHS: Record<string, readonly number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
};

const DISC = { b: 0x25, g: 0x30, r: 0xd9 };

/** The label drawn for `count`: `1` .. `9`, then `9+`. */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(Math.max(0, Math.floor(count)));
}

/**
 * Returns a copy of the square `size` x `size` BGRA bitmap `base` with the count badge. A count of 0 returns
 * the unchanged copy.
 */
export function drawCountBadge(base: Buffer, size: number, count: number): Buffer {
  const out = Buffer.from(base);
  if (count <= 0 || size < 16 || out.length < size * size * 4) return out;
  const label = badgeLabel(count);
  const radius = Math.round(size * 0.3);
  const cx = size - radius;
  const cy = size - radius;
  const put = (x: number, y: number, b: number, g: number, r: number, a: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
    const i = (y * size + x) * 4;
    const dst = out[i + 3]! / 255;
    const outA = a + dst * (1 - a);
    const mix = (s: number, d: number) => Math.round((s * a + d * dst * (1 - a)) / outA);
    out[i] = mix(b, out[i]!);
    out[i + 1] = mix(g, out[i + 1]!);
    out[i + 2] = mix(r, out[i + 2]!);
    out[i + 3] = Math.round(outA * 255);
  };
  // the disc, with a soft one pixel edge
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      put(x, y, DISC.b, DISC.g, DISC.r, Math.min(1, Math.max(0, radius + 0.5 - d)));
    }
  }
  // the text, centred in the disc
  const scale = Math.max(1, Math.round((size / 32) * (label.length === 1 ? 3 : 2)));
  const gap = scale;
  const width = label.length * 3 * scale + (label.length - 1) * gap;
  const left = Math.round(cx - width / 2);
  const top = Math.round(cy - (5 * scale) / 2);
  [...label].forEach((ch, n) => {
    const rows = GLYPHS[ch];
    if (!rows) return;
    const x0 = left + n * (3 * scale + gap);
    rows.forEach((bits, row) => {
      for (let col = 0; col < 3; col++) {
        if ((bits & (0b100 >> col)) === 0) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            put(x0 + col * scale + dx, top + row * scale + dy, 255, 255, 255, 1);
          }
        }
      }
    });
  });
  return out;
}
