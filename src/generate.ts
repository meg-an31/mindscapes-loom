/*
 * Talking to models. One entry point, `generate`: given the conversation (as turns, the last one
 * being the message to write into) and a model profile, it streams text chunks, each with the
 * model's token probabilities when the backend reports them.
 *
 * Modes:
 * - demo: lorem ipsum with made-up probabilities, so the interface works with no backend.
 * - completions: OpenAI-style /completions. The conversation is written out as one document
 *   (see Format), so it can continue anything: a model reply, half a reply, or your own message.
 * - chat: OpenAI-style /chat/completions. It can only write assistant messages; continuing a
 *   half-written one needs a backend that supports prefill (llama-server does; vLLM needs
 *   `continue_final_message` in the extra JSON).
 * - browser: a small chat model running in this page's worker (see model/). It leaves the last
 *   turn open, so it carries on whoever's turn that is. Its settings come from the address
 *   (?model= &temp= &max=, see model/client.ts), not from these.
 */
import { generate as browserGenerate, useModel } from './model/client';
import type { Format, ModelProfile, Sampling } from './settings';
import { roundLp } from './tokens';

export type Role = 'user' | 'model';

export interface Turn {
  role: Role;
  text: string;
}

export interface GenToken {
  t: string;
  lp: number;
  top?: [string, number][];
}

/** A token placed in the output: `o` is its char offset from the start of this generation's text. */
export interface PlacedToken extends GenToken {
  o: number;
}

export interface DoneInfo {
  finish?: string;
  error?: string;
}

export interface StreamHandle {
  cancel(): void;
}

export interface GenRequest {
  turns: Turn[];
  profile: ModelProfile;
  sampling: Sampling;
  format: Format;
  apiKey?: string;
  /** demo only: start with a space (carrying on text that doesn't end in one) */
  leadingSpace?: boolean;
  /** drop leading whitespace: the text starts a message of its own */
  trimStart?: boolean;
  /** progress the server reports while waiting (e.g. a model booting) */
  onStatus?: (status: string) => void;
}

/** text: new text to append. toks: tokens now known to line up with the text (possibly earlier text). */
type OnChunk = (text: string, toks?: PlacedToken[]) => void;
type RawChunk = (text: string, toks?: GenToken[]) => void;
type OnDone = (info: DoneInfo) => void;

/**
 * Lines tokens up with text over the whole stream. Servers don't promise a chunk's tokens spell
 * its text: vLLM holds text back while checking stop strings, so the tokens run ahead of it, and
 * the tokens of a matched stop string never appear as text at all. So tokens are laid end to end
 * from the start, and each is released once the text it covers has arrived and matches. If they
 * ever disagree, the rest are dropped rather than shown against the wrong characters.
 */
export class Aligner {
  private raw = '';
  private toks: PlacedToken[] = [];
  private tokEnd = 0;
  private next = 0;
  private broken = false;
  private skip = 0;
  constructor(private trimming: boolean) {}

  push(text: string, toks?: GenToken[]): { text: string; toks: PlacedToken[] } {
    for (const k of toks ?? []) {
      this.toks.push({ ...k, o: this.tokEnd });
      this.tokEnd += k.t.length;
    }
    this.raw += text;
    let out = text;
    if (this.trimming) {
      const body = this.raw.trimStart();
      if (!body) return { text: '', toks: [] };
      this.skip = this.raw.length - body.length;
      this.trimming = false;
      out = body;
    }
    return { text: out, toks: this.release() };
  }

  private release(): PlacedToken[] {
    const out: PlacedToken[] = [];
    while (!this.broken && this.next < this.toks.length) {
      const k = this.toks[this.next];
      const end = k.o + k.t.length;
      if (end > this.raw.length) break;
      if (this.raw.slice(k.o, end) !== k.t) {
        this.broken = true;
        break;
      }
      this.next++;
      if (end <= this.skip) continue; // all trimmed whitespace
      if (k.o < this.skip) out.push({ ...k, t: k.t.slice(this.skip - k.o), o: 0 });
      else out.push({ ...k, o: k.o - this.skip });
    }
    return out;
  }
}

export function generate(req: GenRequest, onChunkOut: OnChunk, onDone: OnDone): StreamHandle {
  const al = new Aligner(!!req.trimStart);
  const onChunk: RawChunk = (text, toks) => {
    const r = al.push(text, toks);
    if (r.text || r.toks.length) onChunkOut(r.text, r.toks.length ? r.toks : undefined);
  };
  if (req.profile.mode === 'demo') return demo(req, onChunk, onDone);
  if (req.profile.mode === 'browser') return browser(req, onChunk, onDone);
  const built = buildBody(req);
  if ('error' in built) {
    // report asynchronously, like any other ending, so callers can rely on one code path
    const t = window.setTimeout(() => onDone({ error: built.error }), 0);
    return { cancel: () => window.clearTimeout(t) };
  }
  const ctl = new AbortController();
  let finished = false;
  let heard = false;
  const stopWatch = watchBoot(req, () => heard || finished);
  const done = (info: DoneInfo) => {
    if (finished) return;
    finished = true;
    stopWatch();
    onDone(info);
  };
  const first: RawChunk = (text, toks) => {
    heard = true;
    onChunk(text, toks);
  };
  void stream(built.url, built.body, req, ctl.signal, first)
    .then((finish) => done({ finish }))
    .catch((e: unknown) => {
      if (ctl.signal.aborted) return done({ finish: 'cancelled' });
      done({ error: e instanceof Error ? e.message : String(e) });
    });
  return {
    cancel: () => {
      ctl.abort();
      done({ finish: 'cancelled' });
    },
  };
}

// ---------- request building ----------

/** The conversation as one document, for a completions model. Exported for the settings preview. */
export function renderPrompt(turns: Turn[], f: Format): { prompt: string; stop: string[] } {
  const prefix = (r: Role) => (r === 'user' ? f.user : f.model);
  const parts = turns.map((t, i) => {
    const last = i === turns.length - 1;
    // an empty last turn ends on its prefix without the trailing space: the model writes its own
    // (" Hello" is one token, a dangling space then "Hello" is an unlikely pair)
    return last && !t.text ? prefix(t.role).replace(/[ \t]+$/, '') : prefix(t.role) + t.text;
  });
  const prompt = (f.preamble ? f.preamble + f.sep : '') + parts.join(f.sep);
  // stop where the next message would begin
  const target = turns[turns.length - 1]?.role ?? 'model';
  const other = prefix(target === 'user' ? 'model' : 'user').trimEnd();
  // a base model often starts the next turn after a single new line, whatever the separator
  const stop = other ? [...new Set([f.sep + other, ...(f.sep.includes('\n') ? ['\n' + other] : [])])] : [];
  return { prompt, stop };
}

export function parseExtra(extra: string): { value: Record<string, unknown> } | { error: string } {
  if (!extra.trim()) return { value: {} };
  try {
    const v = JSON.parse(extra);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown> };
    return { error: 'Extra request JSON must be an object, like {"top_k": 40}' };
  } catch {
    return { error: 'Extra request JSON is not valid JSON' };
  }
}

function buildBody(req: GenRequest): { url: string; body: Record<string, unknown> } | { error: string } {
  const { profile: p, sampling: s, turns, format } = req;
  if (!p.baseUrl.trim()) return { error: `${p.label} has no endpoint URL (set it in settings)` };
  const parsed = parseExtra(p.extra);
  if ('error' in parsed) return { error: `${p.label}: ${parsed.error}` };
  const extra = parsed.value;
  const base = p.baseUrl.trim().replace(/\/+$/, '');
  const common: Record<string, unknown> = {
    ...(p.model.trim() ? { model: p.model.trim() } : {}),
    stream: true,
    max_tokens: s.maxTokens,
    temperature: s.temperature,
    top_p: s.topP,
  };
  if (p.mode === 'completions') {
    const { prompt, stop } = renderPrompt(turns, format);
    const body: Record<string, unknown> = { ...common, prompt, ...(stop.length ? { stop } : {}) };
    if (s.alts > 0) body.logprobs = s.alts;
    return { url: `${base}/completions`, body: { ...body, ...extra } };
  }
  // chat
  const last = turns[turns.length - 1];
  if (!last || last.role === 'user')
    return { error: `${p.label} is a chat model, so it can only reply as the assistant. Switch on a base model to have the model write as you.` };
  const msgs = turns.slice(0, last.text ? turns.length : -1);
  if (last.text && !p.prefill)
    return {
      error: `${p.label} is a chat model: it would reply to this message rather than finish it. Use a base model, or tick "can finish a half-written reply" for it in settings if its server supports prefill.`,
    };
  const messages = [
    ...(format.preamble ? [{ role: 'system', content: format.preamble }] : []),
    ...msgs.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text })),
  ];
  const body: Record<string, unknown> = { ...common, messages };
  if (s.alts > 0) {
    body.logprobs = true;
    body.top_logprobs = s.alts;
  }
  return { url: `${base}/chat/completions`, body: { ...body, ...extra } };
}

/**
 * ACS keeps no idle base model running, so a first request can wait minutes while one boots, and
 * the stream says only ": keepalive" meanwhile. If nothing has come after a few seconds, ask the
 * model's status route (it starts no GPU) and report the boot stage until text arrives.
 */
function watchBoot(req: GenRequest, quiet: () => boolean): () => void {
  if (!req.profile.baseUrl.includes('infra.acsresearch.org') || !req.onStatus) return () => {};
  const base = req.profile.baseUrl.trim().replace(/\/+$/, '');
  const model = req.profile.model.trim() || 'llama-8b';
  let timer = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped || quiet()) return;
    try {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/status`, {
        headers: req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {},
      });
      const j = (await res.json()) as { warm?: boolean; boot?: { stage_label?: string; stage_age_s?: number } | null };
      if (stopped || quiet()) return;
      if (j.boot?.stage_label) {
        const s = Math.round(j.boot.stage_age_s ?? 0);
        req.onStatus!(`${model} is starting: ${j.boot.stage_label}${s ? ` · ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : ''}`);
      } else if (j.warm === false) req.onStatus!(`${model} is starting (big models can take several minutes)`);
    } catch {
      /* the status is a nicety: the generation itself reports real failures */
    }
    if (!stopped) timer = window.setTimeout(tick, 5000);
  };
  timer = window.setTimeout(tick, 3000);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

// ---------- streaming ----------

async function stream(
  url: string,
  body: Record<string, unknown>,
  req: GenRequest,
  signal: AbortSignal,
  onChunk: RawChunk,
): Promise<string | undefined> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(`Couldn't reach ${url} (is the server running, and does it allow requests from this page?)`);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw);
      msg = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : msg);
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? `: ${msg}` : ''}`);
  }
  const alts = req.sampling.alts;
  let finish: string | undefined;
  const handle = (j: unknown) => {
    const r = parseChoice(j, alts);
    if (!r) return;
    if (r.text || r.toks?.length) onChunk(r.text, r.toks);
    if (r.finish) finish = r.finish;
  };
  // a server that ignored stream: true sends one JSON body
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
    const raw = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      parseSse(raw, handle, req.onStatus);
      return finish;
    }
    const err = (j as { error?: { message?: string } | string })?.error;
    if (err) throw new Error(typeof err === 'string' ? err : (err.message ?? 'the server reported an error'));
    handle(j);
    return finish;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    // stream: true keeps a multi-byte character split across reads intact
    buf += dec.decode(value, { stream: !done });
    const cut = done ? buf.length : buf.lastIndexOf('\n') + 1;
    if (cut > 0) {
      const ended = parseSse(buf.slice(0, cut), handle, req.onStatus);
      buf = buf.slice(cut);
      if (ended) return finish;
    }
    if (done) return finish;
  }
}

/** Parse complete SSE lines; returns true at [DONE]. */
function parseSse(text: string, handle: (j: unknown) => void, onStatus?: (s: string) => void): boolean {
  for (const line of text.split(/\r?\n/)) {
    // comment lines are keepalives (ACS v2: ": keepalive"); some servers put progress in them
    if (line.startsWith(':')) {
      const st = line.slice(1).replace(/[█░]+/g, '').replace(/\[\s*\]/g, '').trim();
      if (st && !/^keep-?alive$/i.test(st) && onStatus) onStatus(st);
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return true;
    let j: unknown;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    const err = (j as { error?: { message?: string } | string })?.error;
    if (err) throw new Error(typeof err === 'string' ? err : (err.message ?? 'the server reported an error'));
    handle(j);
  }
  return false;
}

type Lp = { token?: string; logprob?: number; top_logprobs?: { token?: string; logprob?: number }[] };

/** Text, finish reason and tokens from one response chunk, in either logprobs shape. Exported for tests. */
export function parseChoice(j: unknown, alts: number): { text: string; finish?: string; toks?: GenToken[] } | null {
  const c = (j as { choices?: unknown[] })?.choices?.[0] as
    | {
        text?: string;
        delta?: { content?: string | null };
        message?: { content?: string | null };
        finish_reason?: string | null;
        logprobs?: {
          content?: Lp[] | null;
          tokens?: string[];
          token_logprobs?: (number | null)[];
          top_logprobs?: (Record<string, number> | null)[] | null;
        } | null;
      }
    | undefined;
  if (!c) return null;
  const text = c.text ?? c.delta?.content ?? c.message?.content ?? '';
  const finish = c.finish_reason ?? undefined;
  const cap = Math.max(0, Math.min(alts, 10));
  let toks: GenToken[] | undefined;
  const lp = c.logprobs;
  if (lp?.content && Array.isArray(lp.content)) {
    // chat shape (also llama-server's completions)
    toks = lp.content
      .filter((k) => typeof k.token === 'string' && typeof k.logprob === 'number')
      .map((k) => ({
        t: k.token!,
        lp: roundLp(k.logprob!),
        top: k.top_logprobs?.length
          ? k.top_logprobs
              .filter((a) => typeof a.token === 'string' && typeof a.logprob === 'number')
              .slice(0, cap)
              .map((a) => [a.token!, roundLp(a.logprob!)] as [string, number])
          : undefined,
      }));
  } else if (lp?.tokens && Array.isArray(lp.tokens)) {
    // legacy completions shape
    toks = lp.tokens.map((t, i) => {
      const top = lp.top_logprobs?.[i];
      return {
        t,
        lp: roundLp(lp.token_logprobs?.[i] ?? 0),
        top: top
          ? Object.entries(top)
              .sort((a, b) => b[1] - a[1])
              .slice(0, cap)
              .map(([k, v]) => [k, roundLp(v)] as [string, number])
          : undefined,
      };
    });
  }
  if (toks) for (const k of toks) if (!k.top?.length) delete k.top;
  return { text, finish, toks: toks?.length ? toks : undefined };
}

// ---------- in this browser ----------

function browser(req: GenRequest, onChunk: RawChunk, onDone: OnDone): StreamHandle {
  // empty turns are no turns, except the last: that is where the model writes
  const turns = req.turns
    .filter((t, i) => t.text || i === req.turns.length - 1)
    .map((t) => ({ role: t.role === 'model' ? ('assistant' as const) : ('user' as const), content: t.text }));
  let ended = false;
  const end = (info: DoneInfo) => {
    if (ended) return;
    ended = true;
    onDone(info);
  };
  const h = browserGenerate(
    turns,
    (text) => onChunk(text),
    (failed) => end(failed ? { error: useModel.getState().error || 'the in-browser model stopped' } : { finish: 'stop' }),
  );
  return {
    cancel: () => {
      h.cancel();
      end({ finish: 'cancelled' });
    },
  };
}

// ---------- demo ----------

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const ALTS = ['the', 'a', 'and', 'of', 'tide', 'moon', 'night', 'salt', 'glass', 'stone', 'quiet', 'river', 'light', 'pool'];

export function shimCompletion(): string {
  return [LOREM, LOREM, LOREM].join(' ');
}

/** A made-up token: its probability and a few alternatives, reproducible from the text and position. */
function fakeToken(t: string, n: number, alts: number): GenToken {
  let h = n * 2654435761;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  const r = ((h >>> 0) % 1000) / 1000;
  const p = r < 0.12 ? 0.04 + r : r < 0.3 ? 0.3 + r : 0.7 + r * 0.29;
  const lead = /^\s/.test(t) ? t.match(/^\s+/)![0] : '';
  const top: [string, number][] = [[t, roundLp(Math.log(p))]];
  let rest = 1 - p;
  for (let i = 0; i < Math.min(alts, 5) - 1; i++) {
    const w = ALTS[((h >>> (i * 3)) + i * 5) % ALTS.length];
    const q = rest * (0.5 - i * 0.07);
    rest -= q;
    if (q > 0.002 && !top.some((x) => x[0] === lead + w)) top.push([lead + w, roundLp(Math.log(q))]);
  }
  top.sort((a, b) => b[1] - a[1]);
  return { t, lp: roundLp(Math.log(p)), top: alts > 0 ? top : undefined };
}

function demo(req: GenRequest, onChunk: RawChunk, onDone: OnDone): StreamHandle {
  const text = (req.leadingSpace ? ' ' : '') + shimCompletion();
  const pieces = text.match(/\s*\S+/g) ?? [];
  const max = Math.max(1, req.sampling.maxTokens);
  let i = 0;
  const timer = window.setInterval(() => {
    const part = pieces.slice(i, Math.min(i + 2, max));
    const toks = part.map((t, k) => fakeToken(t, i + k, req.sampling.alts));
    i += 2;
    if (part.length) onChunk(part.join(''), req.sampling.alts > 0 ? toks : undefined);
    if (i >= pieces.length || i >= max) {
      window.clearInterval(timer);
      onDone({ finish: i >= max && i < pieces.length ? 'length' : 'stop' });
    }
  }, 35);
  return {
    cancel: () => {
      window.clearInterval(timer);
      onDone({ finish: 'cancelled' });
    },
  };
}
