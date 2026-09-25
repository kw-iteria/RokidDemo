// Cheap motion score between consecutive frames of a source (0 = still, 1 = everything changed).
// Used for sources that do not measure motion themselves (replay, raw JPEG senders).
import jpeg from 'jpeg-js';

const prev = new Map<string, Uint8Array>();
const W = 48, H = 36;

export function motionScore(sourceId: string, jpegBuf: Buffer): number {
  let img;
  try { img = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 64 }); } catch { return 0; }
  const small = new Uint8Array(W * H);
  const sx = img.width / W, sy = img.height / H, channels = 3;
  for (let y = 0; y < H; y++) {
    const yy = Math.min(img.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < W; x++) {
      const xx = Math.min(img.width - 1, Math.floor((x + 0.5) * sx));
      const i = (yy * img.width + xx) * channels;
      small[y * W + x] = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8;
    }
  }
  const last = prev.get(sourceId);
  prev.set(sourceId, small);
  if (!last) return 0;
  let sum = 0;
  for (let i = 0; i < small.length; i++) sum += Math.abs(small[i] - last[i]);
  return Math.min(1, sum / small.length / 40); // ~40 gray levels of mean change = "everything moved"
}
