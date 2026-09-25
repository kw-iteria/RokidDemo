// Local press classifier: CLIP ViT-B/32 image embeddings (transformers.js, on this Mac) + a small
// softmax head trained on frames of the press (tools/train_local.ts). ~50 ms per image, no network.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LidState, Verdict } from './vision.ts';

export const HEAD_FILE = resolve(import.meta.dirname, '..', 'model', 'press_head.json');
export const CLIP_MODEL = process.env.LOCAL_EMBEDDER ?? 'Xenova/clip-vit-base-patch32';

export interface Head { classes: string[]; W: number[][]; b: number[]; dim: number; trained_at?: string; cv_accuracy?: number; embedder?: string; real_accuracy?: number }

let extractor: any = null;
let extractorModel = '';
let loading: Promise<any> | null = null;
let head: Head | null = null;
let headMtime = 0;

export function localAvailable(): boolean { return existsSync(HEAD_FILE); }

export async function loadExtractor(model?: string): Promise<any> {
  const want = model ?? loadHead()?.embedder ?? CLIP_MODEL;
  if (extractor && extractorModel === want) return extractor;
  if (!loading || extractorModel !== want) {
    extractorModel = want;
    loading = import('@huggingface/transformers').then(async (T) => {
      extractor = await T.pipeline('image-feature-extraction', want, { dtype: 'fp32' });
      (extractor as any).__T = T;
      (extractor as any).__model = want;
      return extractor;
    });
  }
  return loading;
}

export function loadHead(): Head | null {
  if (!existsSync(HEAD_FILE)) return null;
  const { mtimeMs } = statSync(HEAD_FILE);
  if (!head || mtimeMs !== headMtime) { head = JSON.parse(readFileSync(HEAD_FILE, 'utf8')); headMtime = mtimeMs; }
  return head;
}

export async function embed(jpeg: Buffer, model?: string): Promise<Float32Array> {
  const ex = await loadExtractor(model);
  const T = ex.__T;
  const img = await T.RawImage.fromBlob(new Blob([jpeg], { type: 'image/jpeg' }));
  const out = await ex(img, { pooling: /dinov2/i.test(ex.__model) ? 'cls' : 'mean', normalize: true });
  return Float32Array.from(out.data as Float32Array);
}

export function predict(h: Head, x: Float32Array): { label: string; probs: Record<string, number> } {
  const logits = h.classes.map((_, k) => { let z = h.b[k]; const w = h.W[k]; for (let i = 0; i < h.dim; i++) z += w[i] * x[i]; return z; });
  const m = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs: Record<string, number> = {};
  h.classes.forEach((c, k) => (probs[c] = exps[k] / sum));
  const label = h.classes[exps.indexOf(Math.max(...exps))];
  return { label, probs };
}

/** Classify one image (full frame or zoom crop). Confidence is the class probability. */
export async function classifyLocal(jpeg: Buffer, minProb = 0.8): Promise<{ verdict: Verdict; probs: Record<string, number>; latency_ms: number }> {
  const t0 = performance.now();
  const h = loadHead();
  if (!h) throw new Error('local classifier not trained (run: node tools/train_local.ts)');
  const x = await embed(jpeg);
  const { label, probs } = predict(h, x);
  const p = probs[label];
  let lid: LidState = 'unknown';
  let visible = false;
  if (label === 'open' || label === 'closed') { visible = true; lid = p >= minProb ? label : 'partial'; }
  else if (label === 'partial') { visible = true; lid = 'partial'; }
  return { verdict: { press_visible: visible, lid, confidence: p, hand_on_press: false }, probs, latency_ms: performance.now() - t0 };
}
