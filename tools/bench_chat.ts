// Chat latency benchmark across vendors: time to first token and total time for a short answer,
// plus whether the model calls the right tool for "start the plate press workflow".
//   node tools/bench_chat.ts [--models a,b,c] [--trials 3]
import { loadEnv } from '../server/src/env.ts';
import { streamChat, type ChatMsg, type ChatTool } from '../server/src/chat.ts';

loadEnv();
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const MODELS = (args.get('models') ?? [
  'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-nano',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash',
  'groq/openai/gpt-oss-20b', 'groq/openai/gpt-oss-120b', 'groq/qwen/qwen3.8-27b',
  'cerebras/gpt-oss-120b', 'cerebras/qwen-3.8-27b',
  'xai/grok-4.20-0309-non-reasoning',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const TRIALS = Number(args.get('trials') ?? 3);

const SYSTEM = 'You are a concise lab assistant. Answer in one or two short sentences. Call start_workflow when asked to start, run or begin the plate press workflow.';
const TOOLS: ChatTool[] = [
  { type: 'function', function: { name: 'start_workflow', description: 'Start the plate-press workflow.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'set_press_time', description: 'Set the press time in seconds.', parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'], additionalProperties: false } } },
];
const CASES: { name: string; messages: ChatMsg[]; tools?: ChatTool[]; expectTool?: string }[] = [
  { name: 'fact', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'What is the boiling point of ethanol at sea level?' }] },
  { name: 'tool', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'start plate press workflow' }], tools: TOOLS, expectTool: 'start_workflow' },
  { name: 'tips', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Give me three quick tips for keeping a lab notebook.' }], tools: TOOLS },
];
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : NaN; };

const rows: Record<string, unknown>[] = [];
for (const model of MODELS) {
  const row: Record<string, unknown> = { model };
  let err = '';
  for (const c of CASES) {
    const ttft: number[] = [], total: number[] = [];
    let toolOk = 0, sample = '';
    for (let t = 0; t < TRIALS; t++) {
      try {
        const r = await streamChat(model, c.messages, { tools: c.tools, maxTokens: 300, timeoutMs: 40_000 });
        ttft.push(r.ttft_ms); total.push(r.total_ms);
        if (c.expectTool) { if (r.toolCalls.some((x) => x.function.name === c.expectTool)) toolOk++; }
        sample = r.text.replace(/\s+/g, ' ').slice(0, 70) || (r.toolCalls.length ? `[tool ${r.toolCalls.map((x) => x.function.name).join(',')}]` : '(empty)');
      } catch (e) { err = (e as Error).message.slice(0, 120); }
    }
    row[`${c.name}_ttft`] = med(ttft);
    row[`${c.name}_total`] = med(total);
    if (c.expectTool) row.tool_ok = `${toolOk}/${TRIALS}`;
    if (c.name === 'fact') row.sample = sample;
  }
  if (err) row.error = err;
  rows.push(row);
  console.log(`${model.padEnd(36)} fact ttft ${row.fact_ttft}ms total ${row.fact_total}ms | tool ${row.tool_ok} ttft ${row.tool_ttft}ms | tips total ${row.tips_total}ms ${err ? ' ERR ' + err : ''}  "${row.sample}"`);
}
rows.sort((a, b) => ((a.fact_total as number) || 1e9) - ((b.fact_total as number) || 1e9));
console.log('\nSUMMARY (median ms, sorted by total time for a one-sentence fact)');
console.table(rows.map(({ sample, ...r }) => r));
process.exit(0);
