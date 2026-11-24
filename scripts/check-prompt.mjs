// Checks the text the model is handed, against the real tokenizer of the default model
// (tokenizer files only; no weights). Run from the project folder: node scripts/check-prompt.mjs [cache dir]
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { AutoTokenizer, env } from '@huggingface/transformers';

const out = join(mkdtempSync(join(tmpdir(), 'loom-check-')), 'bundle.mjs');
await build({
  stdin: {
    contents: `export { turnsFor, bubblesOf } from './src/store'; export { buildPrompt } from './src/model/prompt';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});
const { turnsFor, bubblesOf, buildPrompt } = await import(pathToFileURL(out).href);
// what the in-page model is sent (generate.ts, browser mode): empty turns dropped except the last
const chatTurns = (nodes, id) =>
  turnsFor(nodes, id)
    .filter((t, i, all) => t.text || i === all.length - 1)
    .map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text }));

if (process.argv[2]) env.cacheDir = process.argv[2];
const tok = await AutoTokenizer.from_pretrained('onnx-community/Qwen2.5-0.5B-Instruct');

const node = (id, parentId, forkAt, messages) => ({ id, parentId, forkAt, messages, x: 0, y: 0, hidden: false });
const reply = 'Tide pools glow at night, and the crabs come out to look.';
const cut = reply.indexOf('and');
const nodes = {
  root: { ...node('root', null, null, []), isRoot: true },
  // a plain chat, the second reply being written now
  a: node('a', 'root', null, [
    { role: 'user', text: 'tell me about tide pools' },
    { role: 'model', text: reply },
    { role: 'user', text: 'stranger please' },
    { role: 'model', text: '', generating: true },
  ]),
  // a fork part-way through the first reply
  b: node('b', 'a', { msg: 1, offset: cut }, [{ role: 'model', text: '', generating: true }]),
  // a fork inside the first user message, typed on, then answered
  c: node('c', 'a', { msg: 0, offset: 'tell me about '.length }, [
    { role: 'user', text: 'the moon' },
    { role: 'model', text: '', generating: true },
  ]),
  // a fresh reply to the first message (a fork at the first word of the reply)
  d: node('d', 'a', { msg: 1, offset: 0 }, [{ role: 'model', text: '', generating: true }]),
  // carrying on after a finished reply
  e: node('e', 'a', { msg: 1, offset: reply.length }, [{ role: 'model', text: '', generating: true }]),
};
const sys = '<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n';
const u = (t) => `<|im_start|>user\n${t}<|im_end|>\n`;
const a = (t, open) => `<|im_start|>assistant\n${t}${open ? '' : '<|im_end|>\n'}`;
const prompt = (id, system) => buildPrompt(tok, chatTurns(nodes, id), system);

let p = prompt('a');
assert.equal(p.text, sys + u('tell me about tide pools') + a(reply) + u('stranger please') + a('', true));
assert.deepEqual([p.templated, p.trimmed, p.continues], [true, false, false]);
// the same text the library builds for an ordinary reply
const usual = tok.apply_chat_template(
  [
    { role: 'user', content: 'tell me about tide pools' },
    { role: 'assistant', content: reply },
    { role: 'user', content: 'stranger please' },
  ],
  { tokenize: false, add_generation_prompt: true },
);
assert.equal(p.text, usual);

p = prompt('b');
assert.equal(p.text, sys + u('tell me about tide pools') + a(reply.slice(0, cut).trimEnd(), true));
assert.deepEqual([p.trimmed, p.continues], [true, true]);

p = prompt('c');
assert.equal(p.text, sys + u('tell me about the moon') + a('', true));

p = prompt('d');
assert.equal(p.text, sys + u('tell me about tide pools') + a('', true));

p = prompt('e');
assert.equal(p.text, sys + u('tell me about tide pools') + a(reply, true));
assert.deepEqual([p.trimmed, p.continues], [false, true]);

// carrying on a message of yours
p = buildPrompt(tok, [{ role: 'user', content: 'write about ' }]);
assert.equal(p.text, sys + '<|im_start|>user\nwrite about');

// one voice never has two turns in a row: its messages reach the model as one turn, nothing between
// the last piece is the message the model writes into: in the loom it is the one being generated
const turns = (list) =>
  bubblesOf(list.map(([role, text], i) => ({ role, text, generating: i === list.length - 1 })))
    .map((b) => ({ role: b.role === 'model' ? 'assistant' : 'user', content: b.pieces.map((p) => p.text).join('') }))
    .filter((t, i, all) => t.content || i === all.length - 1);
p = buildPrompt(tok, turns([['user', 'one'], ['user', '\ntwo'], ['model', 'a b'], ['model', ' c'], ['user', 'three'], ['model', '']]));
assert.equal(p.text, sys + u('one\ntwo') + a('a b c') + u('three') + a('', true));
// a message with no words is no turn (an old open slot, a branch left empty)
p = buildPrompt(tok, turns([['user', 'one'], ['model', ''], ['user', '\ntwo'], ['model', '']]));
assert.equal(p.text, sys + u('one\ntwo') + a('', true));
// the model writing as the user: a new user turn, left open
p = buildPrompt(tok, turns([['user', 'one'], ['model', 'two'], ['user', '']]));
assert.equal(p.text, sys + u('one') + a('two') + '<|im_start|>user\n');
// the model carrying on what the user said
p = buildPrompt(tok, turns([['user', 'one'], ['model', 'two'], ['user', 'and then']]));
assert.equal(p.text, sys + u('one') + a('two') + '<|im_start|>user\nand then');
// the model speaking first, as the assistant and as the user
assert.equal(buildPrompt(tok, turns([['model', '']])).text, sys + a('', true));
assert.equal(buildPrompt(tok, turns([['user', '']])).text, sys + '<|im_start|>user\n');
assert.equal(buildPrompt(tok, turns([['model', '']]), 'none').text, a('', true));

// system prompt: none, or your own
assert.equal(prompt('d', 'none').text, u('tell me about tide pools') + a('', true));
assert.equal(prompt('d', 'You are a crab.').text, '<|im_start|>system\nYou are a crab.<|im_end|>\n' + u('tell me about tide pools') + a('', true));

// a model with no chat template gets the plain text
p = buildPrompt({ apply_chat_template: () => '' }, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two ' }]);
assert.deepEqual([p.text, p.templated, p.trimmed], ['one\ntwo', false, true]);

// the markers reach the model as single tokens, and nothing else is added
const ids = Array.from(tok(prompt('a').text, { add_special_tokens: false }).input_ids.data, Number);
const start = tok.convert_tokens_to_ids('<|im_start|>');
assert.equal(ids.filter((i) => i === start).length, 5);
assert.equal(tok.decode(ids, { skip_special_tokens: false }), prompt('a').text);

console.log('prompt checks pass:', ids.length, 'tokens for the plain chat');
