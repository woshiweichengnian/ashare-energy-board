import zlib from 'node:zlib';
import { nativeImage, type NativeImage } from 'electron';
import type { MarketDashboardState } from '../../shared/types';

export type TrayIconMood = 'expanding' | 'shrinking' | 'flat' | 'degraded';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const MOOD_COLORS: Record<TrayIconMood, { primary: RgbaColor; accent: RgbaColor }> = {
  // 红涨绿跌：放量用红色，缩量用绿色，平量用冷灰蓝，降级用琥珀橙
  expanding: {
    primary: { r: 248, g: 81, b: 73, a: 255 },
    accent: { r: 255, g: 138, b: 128, a: 255 },
  },
  shrinking: {
    primary: { r: 46, g: 160, b: 67, a: 255 },
    accent: { r: 103, g: 214, b: 122, a: 255 },
  },
  flat: {
    primary: { r: 88, g: 166, b: 255, a: 255 },
    accent: { r: 147, g: 197, b: 253, a: 255 },
  },
  degraded: {
    primary: { r: 210, g: 153, b: 34, a: 255 },
    accent: { r: 245, g: 197, b: 86, a: 255 },
  },
};

const BG_COLOR: RgbaColor = { r: 18, g: 24, b: 34, a: 255 };
const BORDER_COLOR: RgbaColor = { r: 56, g: 68, b: 84, a: 255 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    const srcStart = y * stride;
    raw.set(rgba.subarray(srcStart, srcStart + stride), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba: Uint8Array, size: number, x: number, y: number, color: RgbaColor): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  rgba[idx] = color.r;
  rgba[idx + 1] = color.g;
  rgba[idx + 2] = color.b;
  rgba[idx + 3] = color.a;
}

/**
 * 纯代码生成暗底圆角能量柱 PNG（默认 32x32，支持 16/32 多分辨率跨 DPI 清晰显示）。
 */
export function generateTrayIconPng(mood: TrayIconMood, size = 32): Buffer {
  const pixelSize = Math.max(16, Math.round(size));
  const rgba = new Uint8Array(pixelSize * pixelSize * 4);
  const { primary, accent } = MOOD_COLORS[mood];
  const scale = pixelSize / 32;

  const radius = Math.max(2, Math.round(6 * scale));
  const borderInset = Math.max(1, Math.round(1 * scale));
  const bgInset = Math.max(borderInset + 1, Math.round(2 * scale));

  const isInsideRoundedRect = (x: number, y: number, inset: number): boolean => {
    const min = inset;
    const max = pixelSize - 1 - inset;
    if (x < min || x > max || y < min || y > max) return false;
    const r = Math.max(1, radius - inset);
    const dx = x < min + r ? min + r - x : x > max - r ? x - (max - r) : 0;
    const dy = y < min + r ? min + r - y : y > max - r ? y - (max - r) : 0;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < pixelSize; y++) {
    for (let x = 0; x < pixelSize; x++) {
      if (isInsideRoundedRect(x, y, bgInset)) {
        setPixel(rgba, pixelSize, x, y, BG_COLOR);
      } else if (isInsideRoundedRect(x, y, borderInset)) {
        setPixel(rgba, pixelSize, x, y, BORDER_COLOR);
      }
    }
  }

  // 绘制三根渐高能量柱（按比例适配 16x16 与 32x32）
  const bars: Array<{ x0: number; x1: number; topY: number; color: RgbaColor }> = [
    {
      x0: Math.round(6 * scale),
      x1: Math.round(11 * scale),
      topY: Math.round(17 * scale),
      color: primary,
    },
    {
      x0: Math.round(13 * scale),
      x1: Math.round(18 * scale),
      topY: Math.round(12 * scale),
      color: primary,
    },
    {
      x0: Math.round(20 * scale),
      x1: Math.round(25 * scale),
      topY: Math.round(7 * scale),
      color: accent,
    },
  ];
  const bottomY = Math.round(25 * scale);

  for (const bar of bars) {
    for (let y = bar.topY; y <= bottomY; y++) {
      for (let x = bar.x0; x <= bar.x1; x++) {
        setPixel(rgba, pixelSize, x, y, bar.color);
      }
    }
  }

  return encodeRgbaToPng(pixelSize, pixelSize, rgba);
}

export function resolveTrayIconMood(state: MarketDashboardState | null): TrayIconMood {
  if (!state) return 'flat';
  if (state.status.degraded || state.status.stale || state.marketTotal.degraded) {
    return 'degraded';
  }
  const volumeState = state.marketTotal.metrics?.volumeState;
  if (volumeState === 'EXPANDING') return 'expanding';
  if (volumeState === 'SHRINKING') return 'shrinking';
  return 'flat';
}

const iconCache = new Map<TrayIconMood, NativeImage>();

export function getTrayNativeImage(mood: TrayIconMood): NativeImage {
  const cached = iconCache.get(mood);
  if (cached) return cached;
  const png1x = generateTrayIconPng(mood, 16);
  const png2x = generateTrayIconPng(mood, 32);

  let img: NativeImage;
  if (typeof nativeImage.createEmpty === 'function') {
    img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1.0, width: 16, height: 16, buffer: png1x });
    img.addRepresentation({ scaleFactor: 2.0, width: 32, height: 32, buffer: png2x });
  } else {
    img = nativeImage.createFromBuffer(png2x, { scaleFactor: 2.0 });
  }

  iconCache.set(mood, img);
  return img;
}
