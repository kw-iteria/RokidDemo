// Benchmark vision models on 1-fps frames of the demo clip: latency + accuracy.
//   node tools/bench.ts [--models a,b,c] [--frames all|quick] [--concurrency 3] [--width 480] [--refs]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../server/src/env.ts';
import { CANDIDATE_MODELS, classifyFrame, closeSessions, type LidState } from '../server/src/vision.ts';

loadEnv();
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? 'true' : process.argv[++i]);
}
const models = (args.get('models') ?? CANDIDATE_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const concurrency = Number(args.get('concurrency') ?? 3);
const width = Number(args.get('width') ?? 480);
const useRefs = args.get('refs') === 'true';
const mediaArg = (args.get('media') ?? 'low').toUpperCase();
const geminiMediaResolution = mediaArg === 'NONE' ? null : (mediaArg as 'LOW' | 'MEDIUM' | 'HIGH');

// Ground truth for 1-fps extraction of assets/press_demo_640.mp4 (frame index 1-based).
const TRUTH: Record<number, LidState> = {};
for (const i of [1, 2, 3, 4, 25]) TRUTH[i] = 'open';
for (const i of [5, 6, 7, 23, 24]) TRUTH[i] = 'partial';
for (let i = 8; i <= 22; i++) TRUTH[i] = 'closed';
const QUICK = [1, 3, 4, 5, 7, 8, 9, 14, 20, 23, 24, 25];
const frameIds = args.get('frames') === 'all' ? Object.keys(TRUTH).map(Number) : QUICK;

const outDir = resolve('bench-results');
const frameDir = resolve(outDir, `frames_${width}`);
if (!existsSync(frameDir)) {
  mkdirSync(frameDir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', resolve('assets/press_demo_640.mp4'), '-vf', `fps=1,scale=${width}:-2`, '-q:v', '4', resolve(frameDir, 'f_%03d.jpg')]);
}
const frames = frameIds.map((id) => ({ id, truth: TRUTH[id], jpeg: readFileSync(resolve(frameDir, `f_${String(id).padStart(3, '0')}.jpg`)) }));
const refs = useRefs
  ? readdirSync(resolve('server/refs')).filter((f) => /^(open|closed)\d*\.jpg$/.test(f)).sort().map((f) => ({
      label: f.startsWith('open') ? 'the plate press OPEN (lid raised, inside visible)' : 'the plate press CLOSED (lid down, one flat block)',
      jpeg: readFileSync(resolve('server/refs', f)),
    }))
  : undefined;
// Extra labelled frame folders: --extra open=dir1,closed=dir2 (every jpg in dir gets that truth).
for (const spec of (args.get('extra') ?? '').split(',').filter(Boolean)) {
  const [truth, dir] = spec.split('=');
  for (const f of readdirSync(resolve(dir)).filter((x) => x.endsWith('.jpg')).sort()) frames.push({ id: 200 + frames.length, truth: truth as LidState, jpeg: readFileSync(resolve(dir, f)) });
}
// Negative images (no press at all): expect press_visible=false.
const negDir = args.get('negatives');
if (negDir) for (const f of readdirSync(resolve(negDir)).filter((x) => x.endsWith('.jpg')).sort()) frames.push({ id: 100 + frames.length, truth: 'none' as LidState, jpeg: readFileSync(resolve(negDir, f)) });

async function runPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

const summary: Record<string, unknown>[] = [];
for (const model of models) {
  // warm-up (connection + knob discovery) is not counted
  await classifyFrame(model, frames[0].jpeg, { refs, timeoutMs: 30_000, geminiMediaResolution });
  const t0 = performance.now();
  const results = await runPool(frames, concurrency, (f) => classifyFrame(model, f.jpeg, { refs, timeoutMs: 30_000, geminiMediaResolution }));
  const wall = performance.now() - t0;
  const ok = results.filter((r) => r.verdict);
  const lat = ok.map((r) => r.latency_ms);
  let exact = 0, strictN = 0, strictOk = 0, visible = 0, negN = 0, negFalse = 0;
  const rows: string[] = [];
  results.forEach((r, i) => {
    const f = frames[i];
    const v = r.verdict;
    if (v) {
      if (f.truth === ('none' as LidState)) { negN++; if (v.press_visible) negFalse++; }
      else {
        if (v.press_visible) visible++;
        if (v.lid === f.truth) exact++;
        if (f.truth !== 'partial') { strictN++; if (v.lid === f.truth) strictOk++; }
      }
    }
    rows.push(`  f${String(f.id).padStart(2)} truth=${f.truth.padEnd(7)} got=${(v?.lid ?? 'ERR').padEnd(7)} conf=${v ? v.confidence.toFixed(2) : ' -  '} ${Math.round(r.latency_ms)}ms${r.error ? '  ' + r.error.slice(0, 120) : ''}`);
  });
  const row = {
    model, n: frames.length, errors: results.length - ok.length,
    p50_ms: Math.round(pct(lat, 0.5)), p90_ms: Math.round(pct(lat, 0.9)), mean_ms: Math.round(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)),
    exact_acc: +(exact / (frames.length - negN || 1)).toFixed(2), strict_acc: +(strictOk / (strictN || 1)).toFixed(2), visible_rate: +(visible / (ok.length - negN || 1)).toFixed(2), false_pos: negN ? `${negFalse}/${negN}` : '-',
    wall_ms: Math.round(wall),
  };
  summary.push(row);
  console.log(`\n=== ${model} ===  p50=${row.p50_ms}ms p90=${row.p90_ms}ms mean=${row.mean_ms}ms  exact=${row.exact_acc} strict=${row.strict_acc} false_pos=${row.false_pos} errors=${row.errors}`);
  console.log(rows.join('\n'));
  const first = results.find((r) => r.error);
  if (first) console.log('  first error:', first.error);
}
summary.sort((a, b) => (a.p50_ms as number) - (b.p50_ms as number));
console.log('\n\nSUMMARY (sorted by p50 latency; strict_acc excludes the ambiguous partial frames)');
console.table(summary);
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `bench_${new Date().toISOString().replace(/[:.]/g, '-')}_w${width}_${mediaArg.toLowerCase()}${useRefs ? '_refs' : ''}.json`);
writeFileSync(file, JSON.stringify({ width, refs: useRefs, frames: frameIds, summary }, null, 2));
console.log('saved', file);
closeSessions();
process.exit(0);
