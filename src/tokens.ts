/*
 * What the model reported about the text it wrote, stored on the message beside the text.
 *
 * - `toks`: one entry per model token, at char offset `o` of the message. Their texts are the
 *   exact characters they cover (they never overlap; hand-written text simply has none).
 * - `spans`: which model wrote which range of the message, and when. A message can hold several
 *   (you write half, the model completes it; or two models in turn).
 *
 * Every operation that cuts or joins message text goes through sliceGen / concatGen so the
 * offsets stay in line with the text.
 */

export interface TokInfo {
  /** char offset in the message */
  o: number;
  /** the token's text */
  t: string;
  /** natural log of its probability */
  lp: number;
  /** the model's top alternatives at this position (including the chosen one), most likely first */
  top?: [string, number][];
}

export interface Span {
  /** char range [s, e) of the message */
  s: number;
  e: number;
  /** the model's label (as set in settings) */
  model: string;
  /** ms since epoch when generation started */
  at: number;
  temp?: number;
  finish?: string;
}

export interface Gen {
  text: string;
  toks?: TokInfo[];
  spans?: Span[];
}

const orUndef = <T>(a: T[] | undefined) => (a && a.length ? a : undefined);

/** The part [start, end) of a message, with its token and span data cut to match. */
export function sliceGen<M extends Gen>(m: M, start: number, end: number = m.text.length): M {
  const text = m.text.slice(start, end);
  const toks = m.toks?.filter((k) => k.o >= start && k.o + k.t.length <= end).map((k) => ({ ...k, o: k.o - start }));
  const spans = m.spans
    ?.map((s) => ({ ...s, s: Math.max(s.s, start) - start, e: Math.min(s.e, end) - start }))
    .filter((s) => s.e > s.s);
  return { ...m, text, toks: orUndef(toks), spans: orUndef(spans) };
}

/** `a` followed by `b`, as one message (keeps a's other fields). */
export function concatGen<M extends Gen>(a: M, b: Gen): M {
  const d = a.text.length;
  const toks = [...(a.toks ?? []), ...(b.toks ?? []).map((k) => ({ ...k, o: k.o + d }))];
  const spans = [...(a.spans ?? []), ...(b.spans ?? []).map((s) => ({ ...s, s: s.s + d, e: s.e + d }))];
  return { ...a, text: a.text + b.text, toks: orUndef(toks), spans: orUndef(spans) };
}

/** The model token covering char `offset`, if the model wrote it. */
export function tokenAt(m: Gen, offset: number): TokInfo | undefined {
  const ts = m.toks;
  if (!ts) return undefined;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = ts[mid];
    if (offset < k.o) hi = mid - 1;
    else if (offset >= k.o + k.t.length) lo = mid + 1;
    else return k;
  }
  return undefined;
}

/** The span covering char `offset`. */
export function spanAt(m: Gen, offset: number): Span | undefined {
  return m.spans?.find((s) => offset >= s.s && offset < s.e);
}

/** Lowest token probability over [start, end): how unsure the model was anywhere in this word. */
export function minProb(m: Gen, start: number, end: number): number | undefined {
  const ts = m.toks;
  if (!ts) return undefined;
  let p: number | undefined;
  for (const k of ts) {
    if (k.o >= end) break;
    if (k.o + k.t.length <= start) continue;
    const q = Math.exp(k.lp);
    p = p === undefined ? q : Math.min(p, q);
  }
  return p;
}

/** Round for storage: logprobs to 3 decimals keeps a percentage to well under 0.1%. */
export const roundLp = (lp: number) => Math.round(lp * 1000) / 1000;

export const pct = (lp: number) => {
  const p = Math.exp(lp) * 100;
  return p >= 99.95 ? '100%' : p >= 10 ? `${p.toFixed(0)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
};

/** Show a token's text with its whitespace visible. */
export const showTok = (t: string) => (t === '' ? '∅' : t.replace(/ /g, '·').replace(/\n/g, '↵').replace(/\t/g, '⇥'));
