// "Look closer": when the press is small in the frame, crop around its last known location so the
// model sees it large. Boxes are normalized [x0,y0,x1,y1]; a crop maps model boxes back to the frame.
import sharp from 'sharp';

export interface Crop { x0: number; y0: number; x1: number; y1: number } // normalized, in full-frame coordinates

export const MIN_BOX_AREA = 0.02;      // below this fraction of the frame the press is "far" (unreliable)
export const ZOOM_TRIGGER_AREA = 0.12; // crop when the box covers less than this
const MARGIN = 0.9;                    // crop = box grown by this fraction of its size on each side
const MIN_CROP = 0.35;                 // never crop tighter than this fraction of the frame

export function cropAround(box: [number, number, number, number]): Crop {
  const w = box[2] - box[0], h = box[3] - box[1];
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const cw = Math.max(MIN_CROP, w * (1 + 2 * MARGIN)), ch = Math.max(MIN_CROP, h * (1 + 2 * MARGIN));
  const side = Math.max(cw, ch); // square-ish crop keeps the aspect the model expects
  let x0 = cx - side / 2, y0 = cy - side / 2, x1 = cx + side / 2, y1 = cy + side / 2;
  if (x0 < 0) { x1 -= x0; x0 = 0; } if (y0 < 0) { y1 -= y0; y0 = 0; }
  if (x1 > 1) { x0 -= x1 - 1; x1 = 1; } if (y1 > 1) { y0 -= y1 - 1; y1 = 1; }
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(1, x1), y1: Math.min(1, y1) };
}

/** Box seen inside a crop → box in full-frame coordinates. */
export function uncrop(box: [number, number, number, number], crop: Crop): [number, number, number, number] {
  const w = crop.x1 - crop.x0, h = crop.y1 - crop.y0;
  return [crop.x0 + box[0] * w, crop.y0 + box[1] * h, crop.x0 + box[2] * w, crop.y0 + box[3] * h];
}

export function boxArea(box?: [number, number, number, number]): number {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export async function cropJpeg(jpeg: Buffer, crop: Crop, longEdge = 480): Promise<Buffer> {
  const img = sharp(jpeg);
  const meta = await img.metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (!W || !H) return jpeg;
  const left = Math.round(crop.x0 * W), top = Math.round(crop.y0 * H);
  const width = Math.max(16, Math.round((crop.x1 - crop.x0) * W)), height = Math.max(16, Math.round((crop.y1 - crop.y0) * H));
  const out = img.extract({ left, top, width: Math.min(width, W - left), height: Math.min(height, H - top) });
  return (width > longEdge || height > longEdge ? out.resize({ width: width >= height ? longEdge : undefined, height: height > width ? longEdge : undefined }) : out).jpeg({ quality: 78 }).toBuffer();
}
