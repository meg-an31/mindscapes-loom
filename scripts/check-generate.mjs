// Checks for the model client (src/generate.ts) and token data (src/tokens.ts), no server or key needed:
// the stream aligner on real ACS chunks (v1 and v2: text held back for stop strings, k+1 alternatives), both
// logprobs shapes, the prompt a base model is sent, cutting and joining messages with their tokens, and a mock
// SSE server that splits lines and UTF-8 characters across reads, with a status comment, a keepalive and an
// error frame after a 200.  node scripts/check-generate.mjs
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(mkdtempSync(join(tmpdir(), 'loom-gen-')), 'bundle.mjs');
await build({
  stdin: { contents: `export { Aligner, parseChoice, renderPrompt, generate } from './src/generate'; export { sliceGen, concatGen } from './src/tokens';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { Aligner, parseChoice, renderPrompt, generate, sliceGen, concatGen } = await import(pathToFileURL(out).href);
globalThis.window = globalThis; // generate() schedules with window.setTimeout

let fails = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.log('FAIL', name, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); }
};
const run = (chunks, trim, k = 5) => {
  const al = new Aligner(trim); let text = ''; const toks = [];
  for (const c of chunks) { const p = parseChoice({ choices: [c] }, k); const r = al.push(p.text, p.toks); text += r.text; toks.push(...r.toks); }
  return { text, toks };
};

// ACS v1 (captured): text held back while the stop string is checked
const v1 = [
  { text: '', logprobs: { tokens: [' Hello'], token_logprobs: [-1.96], top_logprobs: [{ ' Hello': -1.96, ' Hi': -1.65 }] } },
  { text: ' He', logprobs: { tokens: ['.\n\n'], token_logprobs: [-1.69], top_logprobs: [{ '.\n\n': -1.69 }] } },
  { text: 'llo.', logprobs: { tokens: ['User'], token_logprobs: [-0.13], top_logprobs: [{ User: -0.13 }] } },
  { text: '', logprobs: { tokens: [':'], token_logprobs: [-0.01], top_logprobs: [{ ':': -0.01 }] }, finish_reason: 'stop' },
];
for (const trim of [false, true]) {
  const r = run(v1, trim);
  eq(`v1 text trim=${trim}`, r.text, trim ? 'Hello.' : ' Hello.');
  eq(`v1 toks trim=${trim}`, r.toks.map((k) => [k.o, k.t]), [[0, trim ? 'Hello' : ' Hello']]);
  eq(`v1 alternatives sorted trim=${trim}`, r.toks[0].top.map((x) => x[0]), [' Hi', ' Hello']);
}
// ACS v2 (captured 2026-11-24): the same holding back, and k+1 entries in a top_logprobs map
const v2 = [
  { text: '', logprobs: { tokens: [' \n\n'], token_logprobs: [-5.08], top_logprobs: [{ ' \n\n': -5.08, ' Hi': -1.7, ' Hello': -2.02, ' hi': -2.27 }] } },
  { text: '', logprobs: { tokens: ['hi'], token_logprobs: [-0.81], top_logprobs: [{ hi: -0.81, User: -1.62, What: -4 }] } },
  { text: ' ', logprobs: { tokens: ['\n\n'], token_logprobs: [-1.21], top_logprobs: [{ '\n\n': -1.21 }] } },
  { text: '\n\nhi\n\nUser', logprobs: { tokens: ['User'], token_logprobs: [-0.83], top_logprobs: [{ User: -0.83 }] }, finish_reason: 'length' },
];
for (const trim of [false, true]) {
  const r = run(v2, trim, 3);
  eq(`v2 text trim=${trim}`, r.text, trim ? 'hi\n\nUser' : ' \n\nhi\n\nUser');
  eq(`v2 toks trim=${trim}`, r.toks.map((k) => [k.o, k.t]), trim ? [[0, 'hi'], [2, '\n\n'], [4, 'User']] : [[0, ' \n\n'], [3, 'hi'], [5, '\n\n'], [7, 'User']]);
  eq(`v2 alternatives capped trim=${trim}`, r.toks[0].top.length <= 3, true);
  eq(`v2 every token is its text trim=${trim}`, r.toks.every((k) => r.text.slice(k.o, k.o + k.t.length) === k.t), true);
}
// chat shape
{
  const r = run([
    { delta: { content: 'Hi' }, logprobs: { content: [{ token: 'Hi', logprob: -0.5, top_logprobs: [{ token: 'Hi', logprob: -0.5 }, { token: 'Yo', logprob: -2 }] }] } },
    { delta: { content: ' there' }, logprobs: { content: [{ token: ' there', logprob: -0.2, top_logprobs: [] }] } },
  ], false);
  eq('chat shape', [r.text, r.toks.map((k) => [k.o, k.t, !!k.top])], ['Hi there', [[0, 'Hi', true], [2, ' there', false]]]);
}
// tokens that stop matching the text are dropped, the text keeps flowing
{ const al = new Aligner(false); const a = al.push('abc', [{ t: 'abd', lp: -1 }]); const b = al.push('def', [{ t: 'def', lp: -1 }]); eq('mismatch', [a.toks.length, b.toks.length, a.text + b.text], [0, 0, 'abcdef']); }
// whitespace trimmed across chunks
{ const al = new Aligner(true); const a = al.push(' ', [{ t: ' ', lp: -1 }]); const b = al.push(' \nX', [{ t: ' \nX', lp: -2 }]); eq('trim across chunks', [a.text, b.text, b.toks.map((k) => [k.o, k.t])], ['', 'X', [[0, 'X']]]); }
// what a base model is sent
const T = { preset: 'transcript', user: 'User: ', model: 'Assistant: ', sep: '\n\n', preamble: '' };
eq('prompt: a reply', renderPrompt([{ role: 'user', text: 'hi' }, { role: 'model', text: '' }], T), { prompt: 'User: hi\n\nAssistant:', stop: ['\n\nUser:', '\nUser:'] });
eq('prompt: the model writing as you', renderPrompt([{ role: 'model', text: 'hi' }, { role: 'user', text: '' }], T), { prompt: 'Assistant: hi\n\nUser:', stop: ['\n\nAssistant:', '\nAssistant:'] });
eq('prompt: half a reply', renderPrompt([{ role: 'user', text: 'hi' }, { role: 'model', text: 'Hel' }], { ...T, preamble: 'P' }).prompt, 'P\n\nUser: hi\n\nAssistant: Hel');
eq('prompt: raw', renderPrompt([{ role: 'user', text: 'once upon' }, { role: 'model', text: '' }], { preset: 'raw', user: '', model: '', sep: '', preamble: '' }), { prompt: 'once upon', stop: [] });
// cutting and joining a message keeps its text, its tokens' places and its spans
{
  const m = { text: 'Hello there world', toks: [{ o: 0, t: 'Hello', lp: -1 }, { o: 5, t: ' there', lp: -2 }, { o: 11, t: ' world', lp: -3 }], spans: [{ s: 0, e: 17, model: 'x', at: 1 }] };
  for (const cut of [0, 3, 5, 11, 17]) {
    const back = concatGen(sliceGen(m, 0, cut), sliceGen(m, cut));
    eq(`split/join text @${cut}`, back.text, m.text);
    eq(`split/join tokens @${cut}`, (back.toks ?? []).every((k) => back.text.slice(k.o, k.o + k.t.length) === k.t), true);
    eq(`split/join spans @${cut}`, back.spans.reduce((a, s) => a + s.e - s.s, 0), 17);
  }
}
// a mock server: 7-byte writes split lines and characters; a keepalive, a status comment, both shapes, an error after 200
const frames = (shape) => ['Ca', 'fé', ' ☕', ' ok'].map((t) => 'data: ' + JSON.stringify(shape === 'legacy'
  ? { choices: [{ text: t, logprobs: { tokens: [t], token_logprobs: [-0.5], top_logprobs: [{ [t]: -0.5, x: -3 }] } }] }
  : { choices: [{ delta: { content: t }, logprobs: { content: [{ token: t, logprob: -0.5, top_logprobs: [{ token: t, logprob: -0.5 }] }] } }] }) + '\n\n').join('')
  + 'data: ' + JSON.stringify({ choices: [{ text: '', delta: {}, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n';
const srv = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (JSON.parse(body).model === 'err') return res.end('data: {"error":{"message":"budget_exceeded"}}\n\n');
  const buf = Buffer.from(': keepalive\n\n: [██░░] Waiting for GPUs · 0m05s\n' + frames(req.url.includes('chat') ? 'chat' : 'legacy'));
  for (let i = 0; i < buf.length; i += 7) { res.write(buf.subarray(i, i + 7)); await new Promise((r) => setTimeout(r, 1)); }
  res.end();
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const call = (mode, model = 'm') => new Promise((done) => {
  let text = ''; const toks = []; const status = [];
  generate({ turns: [{ role: 'user', text: 'q' }, { role: 'model', text: '' }], profile: { id: 'x', label: 'x', mode, baseUrl: `http://127.0.0.1:${port}/v1`, model, prefill: false, extra: '', on: true },
    sampling: { temperature: 1, maxTokens: 9, topP: 1, alts: 5 }, format: T, onStatus: (s) => status.push(s) },
    (t, k) => { text += t; if (k) toks.push(...k); }, (info) => done({ text, toks: toks.map((k) => [k.o, k.t]), info, status }));
});
for (const mode of ['completions', 'chat']) {
  const r = await call(mode);
  eq(`mock ${mode}`, [r.text, r.toks, r.info.finish, r.status], ['Café ☕ ok', [[0, 'Ca'], [2, 'fé'], [4, ' ☕'], [6, ' ok']], 'length', ['Waiting for GPUs · 0m05s']]);
}
eq('mock: error frame after a 200', (await call('completions', 'err')).info.error, 'budget_exceeded');
srv.close();
console.log(fails ? `${fails} generate checks FAILED` : 'generate checks pass');
process.exit(fails ? 1 : 0);
