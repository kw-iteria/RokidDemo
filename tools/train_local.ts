// Train the local press classifier head on labelled frames.
//   node tools/train_local.ts [--dump bench-results/bboxes_gpt54.json]
// Uses the cloud model's bounding boxes to make zoom-style crops (what the live pipeline sends when the
// press is small), trains a softmax head on CLIP embeddings, reports leave-one-clip-out accuracy, and
// writes server/model/press_head.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import sharp from 'sharp';
import { embed, HEAD_FILE, predict, type Head } from '../server/src/local.ts';
import { cropAround, cropJpeg, boxArea } from '../server/src/zoom.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const dump = JSON.parse(readFileSync(resolve(args.get('dump') ?? 'bench-results/bboxes_gpt54.json'), 'utf8')) as { path: string; clip: string; truth: string; verdict: { press_visible: boolean; bbox?: number[] } | null }[];
// Real frames labelled by the cloud verifier during live use (server writes them to data/live).
import { existsSync, readdirSync } from 'node:fs';
const liveDir = resolve(args.get('live') ?? 'data/live');
if (existsSync(liveDir)) {
  for (const f of readdirSync(liveDir).filter((x) => x.endsWith('.json')).sort()) {
    const meta = JSON.parse(readFileSync(resolve(liveDir, f), 'utf8'));
    const jpg = resolve(liveDir, f.replace('.json', '.jpg'));
    if (!existsSync(jpg)) continue;
    dump.push({ path: jpg, clip: 'live', truth: meta.lid, verdict: { press_visible: meta.lid !== 'none', bbox: meta.bbox ?? undefined } });
  }
  console.log(`live frames: ${dump.filter((d) => d.clip === 'live').length}`);
}

interface Sample { x: Float32Array; y: string; clip: string; kind: string }
const samples: Sample[] = [];
const CLASSES = ['open', 'closed', 'partial', 'none'];

async function randomBackgroundCrop(jpeg: Buffer, box: number[] | undefined): Promise<Buffer | null> {
  // a crop that avoids the press: used as extra "none" examples so the classifier learns the lab, not just the box
  const meta = await sharp(jpeg).metadata(); const W = meta.width!, H = meta.height!;
  for (let tries = 0; tries < 10; tries++) {
    const size = 0.4 + Math.random() * 0.3;
    const x0 = Math.random() * (1 - size), y0 = Math.random() * (1 - size);
    const x1 = x0 + size, y1 = y0 + size;
    if (box && !(x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3])) continue; // overlaps the press
    return sharp(jpeg).extract({ left: Math.round(x0 * W), top: Math.round(y0 * H), width: Math.round(size * W), height: Math.round(size * H) }).jpeg({ quality: 80 }).toBuffer();
  }
  return null;
}

/** Simulate a distant / blurry view: shrink to `width` px and blow back up. */
async function degrade(jpeg: Buffer, width: number): Promise<Buffer> {
  const meta = await sharp(jpeg).metadata();
  const small = await sharp(jpeg).resize({ width }).jpeg({ quality: 70 }).toBuffer();
  return sharp(small).resize({ width: meta.width }).jpeg({ quality: 80 }).toBuffer();
}

let n = 0;
for (const row of dump) {
  const jpeg = readFileSync(row.path);
  const y = row.truth === 'none' ? 'none' : row.truth;
  const box = row.verdict?.press_visible && row.verdict.bbox && boxArea(row.verdict.bbox as [number, number, number, number]) > 0 ? row.verdict.bbox : undefined;
  // full frame
  samples.push({ x: await embed(jpeg), y, clip: row.clip, kind: 'full' });
  // zoom crop around the press (as the live pipeline does when it is small), plus blurry versions of it
  if (box && y !== 'none') {
    const crop = await cropJpeg(jpeg, cropAround(box as [number, number, number, number]));
    samples.push({ x: await embed(crop), y, clip: row.clip, kind: 'crop' });
    for (const w of [120, 72]) samples.push({ x: await embed(await degrade(crop, w)), y, clip: row.clip, kind: `crop@${w}` });
  }
  // background crop -> none
  if (y !== 'none') { const bg = await randomBackgroundCrop(jpeg, box); if (bg) samples.push({ x: await embed(bg), y: 'none', clip: row.clip, kind: 'bg' }); }
  if (++n % 20 === 0) console.log(`embedded ${n}/${dump.length} frames → ${samples.length} samples`);
}
console.log(`samples: ${samples.length}`, Object.fromEntries(CLASSES.map((c) => [c, samples.filter((s) => s.y === c).length])));

function train(data: Sample[], epochs = 400, lr = 0.5, l2 = 1e-3): Head {
  const dim = data[0].x.length;
  const W = CLASSES.map(() => new Array(dim).fill(0)), b = CLASSES.map(() => 0);
  const counts = CLASSES.map((c) => data.filter((s) => s.y === c).length);
  const weights = data.map((s) => data.length / (CLASSES.length * Math.max(1, counts[CLASSES.indexOf(s.y)]))); // class balance
  for (let e = 0; e < epochs; e++) {
    const gW = CLASSES.map(() => new Array(dim).fill(0)), gb = CLASSES.map(() => 0);
    data.forEach((s, si) => {
      const logits = CLASSES.map((_, k) => { let z = b[k]; for (let i = 0; i < dim; i++) z += W[k][i] * s.x[i]; return z; });
      const m = Math.max(...logits); const exps = logits.map((z) => Math.exp(z - m)); const sum = exps.reduce((a, c) => a + c, 0);
      CLASSES.forEach((c, k) => { const p = exps[k] / sum - (s.y === c ? 1 : 0); const g = p * weights[si] / data.length; gb[k] += g; for (let i = 0; i < dim; i++) gW[k][i] += g * s.x[i]; });
    });
    CLASSES.forEach((_, k) => { b[k] -= lr * gb[k]; for (let i = 0; i < dim; i++) W[k][i] -= lr * (gW[k][i] + l2 * W[k][i]); });
  }
  return { classes: CLASSES, W, b, dim };
}

// leave-one-clip-out cross-validation
const clips = [...new Set(samples.map((s) => s.clip))];
let correct = 0, total = 0; const perClass: Record<string, [number, number]> = {};
const confusion: Record<string, Record<string, number>> = {};
for (const held of clips) {
  const trainSet = samples.filter((s) => s.clip !== held), testSet = samples.filter((s) => s.clip === held);
  if (!trainSet.length || !testSet.length) continue;
  const h = train(trainSet);
  for (const s of testSet) {
    const { label } = predict(h, s.x);
    total++; if (label === s.y) correct++;
    perClass[s.y] = perClass[s.y] ?? [0, 0]; perClass[s.y][1]++; if (label === s.y) perClass[s.y][0]++;
    confusion[s.y] = confusion[s.y] ?? {}; confusion[s.y][label] = (confusion[s.y][label] ?? 0) + 1;
  }
  console.log(`held-out ${held}: ${testSet.filter((s) => predict(h, s.x).label === s.y).length}/${testSet.length}`);
}
const acc = correct / total;
console.log(`leave-one-clip-out accuracy: ${(acc * 100).toFixed(1)}% (${correct}/${total})`);
for (const c of CLASSES) if (perClass[c]) console.log(`  ${c.padEnd(8)} ${perClass[c][0]}/${perClass[c][1]}  confusion: ${JSON.stringify(confusion[c])}`);
// strict: open vs closed only
const oc = samples.filter((s) => s.y === 'open' || s.y === 'closed');
const final = train(samples);
final.trained_at = new Date().toISOString(); final.cv_accuracy = +acc.toFixed(4);
mkdirSync(dirname(HEAD_FILE), { recursive: true });
writeFileSync(HEAD_FILE, JSON.stringify(final));
console.log('saved', HEAD_FILE, 'trained on', samples.length, 'samples;', oc.length, 'open/closed');
process.exit(0);
