import { create } from 'zustand';
import { generate, type PlacedToken, type StreamHandle, type Turn } from './generate';
import { apiKeyFor, pickModel, useSettings } from './settings';
import { sliceGen, type Span, type TokInfo } from './tokens';

/*
 * Data model
 * ----------
 * A node holds a stack of chat messages. Sending a message appends to the node you are in.
 * Forking never edits the parent: it makes a new leaf child that remembers where it cut the
 * parent (`forkAt` = message index + char offset). A node's full conversation is
 * its ancestors' messages, each cut at the next child's fork point, then its own messages.
 */

export type Role = 'user' | 'model';
/** the other voice of the two */
export const otherRole = (r: Role): Role => (r === 'model' ? 'user' : 'model');

export interface Message {
  role: Role;
  text: string;
  generating?: boolean;
  /** the model's tokens and probabilities for the parts it wrote (see tokens.ts) */
  toks?: TokInfo[];
  /** which model wrote which part, and when */
  spans?: Span[];
}

/** Where a child cut its parent: everything before `offset` in message `msg` is kept. */
export interface ForkAt {
  msg: number;
  offset: number;
}

export interface LoomNode {
  id: string;
  parentId: string | null;
  /** null only for the root and its direct children (the root has no text) */
  forkAt: ForkAt | null;
  isRoot?: boolean;
  messages: Message[];
  /** center-x / top-y in flow coordinates (React Flow nodeOrigin [0.5, 0]) */
  x: number;
  y: number;
  hidden: boolean;
}

export interface Tab {
  id: string;
  /** a name the user typed; when empty the tab shows the node's first diverging token */
  name: string;
  headId: string;
  color: number;
}

/** A chat window: a column beside the canvas holding a row of tabs, one of them showing. */
export interface Win {
  id: string;
  tabIds: string[];
  activeTabId: string;
  width: number;
  /** the window's colour: every tab in it shares it (assigned when missing) */
  color?: number;
}

/** How many chat windows can be open side by side. */
export const MAX_WINDOWS = 3;
const WIN_W = 300;

export const NODE_W = 236;
export const NODE_H = 108;
export const ROOT_W = 150; // the robot drawing is 494 x 317
export const ROOT_H = 96;
export const GAP_X = 44;
export const GAP_Y = 84;

/** Thread colours: the palette's lilac and palm leaf plus lighter relatives, each bleeding into another (poster outlines). */
/** core: the highlight colour. dark: the message/selected-node background in the chat you're in;
 *  idle: the messages in the other open chats (dimmer). dark is a muted dark shade of core
 *  Values set by Megan with the colour tuner (2026-11-19). */
export const THREAD_COLORS = [
  { name: 'plum', core: '#963c75', fringe: '#963c75', dark: '#3a2230', idle: '#32242d' },
  { name: 'lime', core: '#a8cd42', fringe: '#a8cd42', dark: '#2e390f', idle: '#27300d' },
  { name: 'ultra violet', core: '#595082', fringe: '#595082', dark: '#2d2848', idle: '#2f2c3f' },
];
export const DEFAULT_COLOR = { name: 'plain', core: '#365436', fringe: '#365436', dark: 'var(--node)', idle: 'var(--node)' }; // dark green (emerald depths)

/** A chat colour as CSS values. Each is a CSS variable (--thread-N, --thread-N-dark) falling back to
 *  the palette value, so the colour tuner can restyle every chat live. `hex` is the raw fallback. */
export const colorOf = (i: number | undefined) => {
  if (i === undefined) return { ...DEFAULT_COLOR, hex: DEFAULT_COLOR.core, n: -1 };
  const n = i % THREAD_COLORS.length;
  const t = THREAD_COLORS[n];
  const core = `var(--thread-${n}, ${t.core})`;
  return {
    name: t.name,
    core,
    fringe: core,
    dark: `var(--thread-${n}-dark, ${t.dark})`,
    idle: `var(--thread-${n}-idle, ${t.idle})`,
    hex: t.core,
    n,
  };
};

/** The colour actually in use for a chat right now (after any tuner override), for the canvas. */
export function resolvedColor(i: number | undefined): string {
  const c = colorOf(i);
  if (c.n < 0) return c.hex;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--thread-${c.n}`).trim();
  return v || c.hex;
}

const heightOf = (n: LoomNode) => (n.isRoot ? ROOT_H : NODE_H);
const widthOf = (n: LoomNode) => (n.isRoot ? ROOT_W : NODE_W);

let idSeq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/** live generations, keyed `${nodeId}:${msgIndex}`, oldest first: the model writes one at a time, the rest wait their turn */
const streams = new Map<string, StreamHandle>();
/** the message each live generation writes into; a node split above it moves it (see splitNode) */
const targets = new Map<string, { id: string; msg: number }>();
/** the generations run by the in-page model (by their target): it writes one at a time, so they queue */
const inPage = new WeakSet<{ id: string; msg: number }>();
/** the in-page generations' keys, oldest first */
const pageOrder = () => [...streams.keys()].filter((k) => inPage.has(targets.get(k)!));
const streamKey = (id: string, msg: number) => `${id}:${msg}`;

type Nodes = Record<string, LoomNode>;
type Kids = Record<string, string[]>;

interface Snapshot {
  nodes: Nodes;
  children: Kids;
  /** the open chats at the time, so undoing a delete brings its closed tabs back */
  tabs: Tab[];
  windows: Win[];
  activeWindowId: string | null;
}

export interface LoomState {
  nodes: Nodes;
  children: Kids;
  rootId: string;
  tabs: Tab[];
  /** the chat windows, left to right; every tab is in exactly one */
  windows: Win[];
  /** the window you're in */
  activeWindowId: string | null;
  /** the tab you're in: the active window's showing tab (kept in sync) */
  activeTabId: string | null;
  sidebarFolded: boolean;
  /** bumps on anything that changes the graph's shape (not on streamed text) */
  structure: number;
  tabCounter: number;
  colorCounter: number;
  focusRequest: { tabId: string; n: number } | null;
  /** the in-page model's live generations, oldest first: the first is being written, the others wait
   *  (other backends write side by side, so theirs never wait here) */
  streamOrder: string[];
  toast: { text: string; n: number } | null;
  past: Snapshot[];
  future: Snapshot[];

  /** record an undo point; call before a change */
  commit(): void;
  undo(): void;
  redo(): void;

  /** new leaf child of nodeId (cut at `at`, or after all of it) with a generated model reply */
  forkGenerate(nodeId: string, opts?: { at?: ForkAt; pos?: { x: number; y: number } }): string;
  forkMany(nodeId: string, count: number): void;
  /** new empty leaf child, opened in chat so you can type its first message */
  forkForWriting(nodeId: string, pos?: { x: number; y: number }): void;
  /** fork at a point and either let the model write the next message ('generate') or leave it for you ('write') */
  forkAtPoint(tabId: string, nodeId: string, msg: number, offset: number, kind: 'generate' | 'write', count?: number): void;
  /**
   * Add what you typed to the end of a chat, in a voice. Two messages in one voice never follow
   * each other: the text joins the last message when that one is in the same voice. `auto`: the
   * model then answers in the other voice.
   */
  sendMessage(tabId: string, text: string, role?: Role, auto?: boolean): void;
  /** let the model write at the end of a chat in a voice: it carries the last message on when that is in this voice, else it starts the next one */
  promptModel(tabId: string, role: Role): void;
  /** stop what the model is writing (or waiting to write) in a chat; the words so far stay */
  stopGenerating(tabId: string): void;
  deleteSubtree(id: string): void;
  hideNode(id: string): void;
  showAllBelow(id: string): void;
  moveNode(id: string, x: number, y: number): void;
  /** move several nodes at once (one store update) */
  moveNodes(pos: Record<string, { x: number; y: number }>): void;
  /** delete / hide several nodes as one undo step */
  deleteNodes(ids: string[]): void;
  hideNodes(ids: string[]): void;
  tidy(): void;
  /** show a node in chat: its existing tab if it has one, else a new tab in the window you're in */
  openInChat(id: string, focusInput?: boolean): void;
  /** a node in a tab or a window of its own; a node never has two tabs, so an open one is reused */
  openNodeIn(id: string, where: 'tab' | 'window'): void;
  newTab(): void;
  closeTab(id: string): void;
  closeTabsToRight(id: string): void;
  closeWindow(id: string): void;
  /** move a tab to a position in a window, or into a new window of its own */
  moveTab(tabId: string, to: { windowId: string; index: number } | 'new'): void;
  setActiveTab(id: string): void;
  resizeWindow(id: string, width: number): void;
  renameTab(id: string, name: string): void;
  toggleSidebar(): void;
  /** point a chat at an existing node */
  goToNode(tabId: string, nodeId: string): void;
  showToast(text: string): void;
  reset(): void;
}

// ---------- pure helpers ----------

export function pathTo(nodes: Nodes, id: string): LoomNode[] {
  const out: LoomNode[] = [];
  let cur: LoomNode | undefined = nodes[id];
  while (cur) {
    out.push(cur);
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return out.reverse();
}

/** One visible run of text in a conversation: (part of) one message of one node. */
export interface Piece {
  nodeId: string;
  msg: number;
  role: Role;
  text: string;
  /** true when this piece is the whole message (so an end-of-message fork can be shown after it) */
  whole: boolean;
  generating: boolean;
  /** the message's token data; offsets are message offsets, and the piece starts at offset 0 */
  toks?: TokInfo[];
  spans?: Span[];
}

/** The conversation you see when standing in `headId`. */
export function piecesFor(nodes: Nodes, headId: string): Piece[] {
  const path = pathTo(nodes, headId);
  const out: Piece[] = [];
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    const cut = path[i + 1]?.forkAt;
    const upto = cut ? cut.msg : n.messages.length;
    for (let k = 0; k < Math.min(upto, n.messages.length); k++) {
      const m = n.messages[k];
      out.push({ nodeId: n.id, msg: k, role: m.role, text: m.text, whole: true, generating: !!m.generating, toks: m.toks, spans: m.spans });
    }
    if (cut && n.messages[cut.msg]) {
      const m = n.messages[cut.msg];
      const text = m.text.slice(0, cut.offset);
      if (text)
        out.push({
          nodeId: n.id,
          msg: cut.msg,
          role: m.role,
          text,
          whole: cut.offset >= m.text.length,
          generating: false,
          toks: m.toks,
          spans: m.spans,
        });
    }
  }
  return out;
}

/** One bubble: everything one voice says before the other speaks. */
export interface Bubble {
  role: Role;
  pieces: Piece[];
}

/**
 * The conversation as bubbles. One bubble is everything one voice says before the other speaks:
 * pieces in the same voice always join, whatever nodes they sit in, so no voice ever has two
 * bubbles in a row. A message with no words is left out, unless the model is about to write it.
 * The chat shows these and the model is sent these, so both agree on where a message ends.
 */
export function bubblesOf(pieces: Piece[]): Bubble[] {
  const bubbles: Bubble[] = [];
  for (const p of pieces) {
    if (!p.text && !p.generating) continue;
    const last = bubbles[bubbles.length - 1];
    if (last && last.role === p.role) last.pieces.push(p);
    else bubbles.push({ role: p.role, pieces: [p] });
  }
  return bubbles;
}

/** The conversation up to and including nodes[id], as the turns a model is sent; the last is the one it writes into. */
export function turnsFor(nodes: Nodes, id: string): Turn[] {
  return bubblesOf(piecesFor(nodes, id)).map((b) => ({ role: b.role, text: b.pieces.map((p) => p.text).join('') }));
}

/** The voice of the last words of the conversation you see when standing in `headId` (null: nothing is written yet). */
export function lastVoice(nodes: Nodes, headId: string): Role | null {
  let n: LoomNode | undefined = nodes[headId];
  let upto = Infinity;
  while (n) {
    for (let k = Math.min(upto, n.messages.length - 1); k >= 0; k--) if (n.messages[k].text || n.messages[k].generating) return n.messages[k].role;
    const f: ForkAt | null = n.forkAt;
    if (!n.parentId || !f) return null;
    // the parent's text up to the cut: a cut at a message's very start leaves that message out
    upto = f.offset > 0 ? f.msg : f.msg - 1;
    n = nodes[n.parentId];
  }
  return null;
}

/** The first word a node adds of its own: where it diverges from its parent. Used as the tab label. */
export function divergingToken(nodes: Nodes, id: string): string {
  const n = nodes[id];
  if (!n || n.isRoot) return 'new thread';
  for (const m of n.messages) {
    const w = m.text.match(/[\p{L}\p{N}_'’]+|[^\s]/u)?.[0];
    if (w) return w.length > 18 ? `${w.slice(0, 17)}…` : w;
  }
  return n.messages.length ? '…' : 'empty';
}

/** The tab showing in each window, left to right (background tabs are not visible). */
/** Width in px of the chat windows floating over the canvas's left side (the rail when folded). */
export function sideWidth(s: Pick<LoomState, 'tabs' | 'windows' | 'sidebarFolded'>): number {
  if (!s.tabs.length) return 0;
  if (s.sidebarFolded) return 46;
  return Math.min(
    s.windows.reduce((a, w) => a + w.width, 0),
    Math.round(window.innerWidth * 0.78),
  );
}

export function visibleTabs(s: Pick<LoomState, 'tabs' | 'windows'>): Tab[] {
  const byId = new Map(s.tabs.map((t) => [t.id, t]));
  return s.windows.map((w) => byId.get(w.activeTabId)).filter((t): t is Tab => !!t);
}

/** node id -> colour of the chat currently on that node (only chats' current nodes, not their
 *  paths; the active chat wins if two share a node). Used for the node outline and the
 *  connector from its parent. */
export function threadColorMap(s: Pick<LoomState, 'nodes' | 'tabs' | 'windows' | 'activeTabId'>): Map<string, number> {
  const map = new Map<string, number>();
  const shown = visibleTabs(s);
  const ordered = [...shown.filter((t) => t.id !== s.activeTabId), ...shown.filter((t) => t.id === s.activeTabId)];
  for (const t of ordered) if (s.nodes[t.headId]) map.set(t.headId, t.color);
  return map;
}

export function contextOf(nodes: Nodes, id: string): string {
  return piecesFor(nodes, id)
    .map((p) => p.text)
    .join('');
}

/** Where a child should cut a node to keep all of it as it is now. */
function endOf(n: LoomNode): ForkAt | null {
  if (n.isRoot) return null;
  if (!n.messages.length) return { msg: 0, offset: 0 };
  const last = n.messages.length - 1;
  return { msg: last, offset: n.messages[last].text.length };
}

export function descendants(children: Kids, id: string): string[] {
  const out: string[] = [];
  const stack = [...(children[id] ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...(children[c] ?? []));
  }
  return out;
}

export function hasHiddenBelow(nodes: Nodes, children: Kids, id: string): boolean {
  return descendants(children, id).some((d) => nodes[d]?.hidden);
}

export function countHiddenChildren(nodes: Nodes, children: Kids, id: string): number {
  return (children[id] ?? []).filter((c) => nodes[c]?.hidden).length;
}

function overlaps(nodes: Nodes, x: number, y: number) {
  for (const n of Object.values(nodes)) {
    if (n.hidden) continue;
    const w = (widthOf(n) + NODE_W) / 2 + GAP_X / 2;
    const h = Math.max(heightOf(n), NODE_H) + 12;
    if (Math.abs(n.x - x) < w && Math.abs(n.y - y) < h) return true;
  }
  return false;
}

function placeChild(nodes: Nodes, children: Kids, parentId: string) {
  const P = nodes[parentId];
  const kids = (children[parentId] ?? []).map((k) => nodes[k]).filter((k) => k && !k.hidden);
  let y = P.y + heightOf(P) + GAP_Y;
  let x = P.x;
  if (kids.length) {
    const right = kids.reduce((a, b) => (b.x > a.x ? b : a));
    x = right.x + NODE_W + GAP_X;
    y = right.y;
  }
  let guard = 0;
  while (overlaps(nodes, x, y) && guard++ < 200) x += NODE_W + GAP_X;
  return { x, y };
}

function tidyPositions(nodes: Nodes, children: Kids, rootId: string): Nodes {
  const slot = NODE_W + GAP_X;
  const pos: Record<string, { x: number; y: number }> = {};
  let cursor = 0;
  // iterative post-order so long chains don't blow the stack
  type Frame = { id: string; y: number; i: number; xs: number[] };
  const stack: Frame[] = [{ id: rootId, y: 0, i: 0, xs: [] }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    const kids = (children[f.id] ?? []).filter((k) => !nodes[k].hidden);
    if (f.i < kids.length) {
      const k = kids[f.i++];
      stack.push({ id: k, y: f.y + heightOf(nodes[f.id]) + GAP_Y, i: 0, xs: [] });
      continue;
    }
    stack.pop();
    const x = f.xs.length ? (f.xs[0] + f.xs[f.xs.length - 1]) / 2 : cursor++ * slot;
    pos[f.id] = { x, y: f.y };
    if (stack.length) stack[stack.length - 1].xs.push(x);
  }
  const dx = -pos[rootId].x;
  const next: Nodes = { ...nodes };
  for (const [id, p] of Object.entries(pos)) next[id] = { ...nodes[id], x: p.x + dx, y: p.y };
  return next;
}

// ---------- seed ----------

/** A fresh loom: the root and one empty chat, waiting for your first message. */
function seed() {
  const nodes: Nodes = { root: { id: 'root', parentId: null, forkAt: null, messages: [], x: 0, y: 0, hidden: false, isRoot: true } };
  const children: Kids = { root: [] };
  const tabs: Tab[] = [{ id: 't1', name: '', headId: 'root', color: 0 }];
  const windows: Win[] = [{ id: 'w1', tabIds: ['t1'], activeTabId: 't1', width: WIN_W, color: 0 }];
  return {
    nodes: tidyPositions(nodes, children, 'root'),
    children,
    rootId: 'root',
    tabs,
    windows,
    activeWindowId: 'w1' as string | null,
    activeTabId: 't1' as string | null,
    sidebarFolded: false,
    tabCounter: 1,
    colorCounter: 1,
  };
}

// ---------- persistence ----------

// the interview build shares a site with the loom: its saves are its own, and the loom's are not ours to read
const SAVE_KEY = 'mindscapes-loom-interview-v1';
const OLD_SAVE_KEY = 'mindscapes-loom-interview-v0'; // never written
type Saved = ReturnType<typeof seed>;

function load(): Saved | null {
  try {
    let s: Saved | null = null;
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) s = JSON.parse(raw) as Saved;
    else {
      // v2 had one column per chat: each becomes a window (up to the limit), the rest join the last
      const old = localStorage.getItem(OLD_SAVE_KEY);
      if (!old) return null;
      const o = JSON.parse(old) as Omit<Saved, 'windows' | 'activeWindowId'> & { tabs: (Tab & { width?: number })[] };
      const windows: Win[] = [];
      for (const t of o.tabs) {
        if (windows.length < MAX_WINDOWS) windows.push({ id: `w${windows.length + 1}`, tabIds: [t.id], activeTabId: t.id, width: t.width ?? WIN_W });
        else windows[windows.length - 1].tabIds.push(t.id);
      }
      const tabs = o.tabs.map(({ id, name, headId, color }) => ({ id, name, headId, color }));
      const activeWindowId = windows.find((w) => w.tabIds.includes(o.activeTabId ?? ''))?.id ?? windows[0]?.id ?? null;
      s = { ...o, tabs, windows, activeWindowId };
    }
    for (const n of Object.values(s.nodes)) {
      // a reply the model had not begun when the page closed (it can take minutes to load) would
      // come back as an empty message waiting for your words in the model's voice: drop it
      n.messages = n.messages.filter((m) => !(m.generating && !m.text));
      for (const m of n.messages) m.generating = false;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Tidy the windows after any change to tabs: drop missing tabs and empty windows, keep each
 * window's showing tab valid, and keep the window/tab you're in valid.
 */
function settleWindows(tabs: Tab[], windows: Win[], activeWindowId: string | null) {
  const ids = new Set(tabs.map((t) => t.id));
  const wins: Win[] = [];
  for (const w of windows) {
    const tabIds = w.tabIds.filter((t) => ids.has(t));
    if (!tabIds.length) continue;
    wins.push({ ...w, tabIds, activeTabId: tabIds.includes(w.activeTabId) ? w.activeTabId : tabIds[0] });
  }
  const placed = new Set(wins.flatMap((w) => w.tabIds));
  const stray = tabs.filter((t) => !placed.has(t.id)).map((t) => t.id);
  if (stray.length) {
    if (wins.length) wins[wins.length - 1] = { ...wins[wins.length - 1], tabIds: [...wins[wins.length - 1].tabIds, ...stray] };
    else wins.push({ id: uid('w'), tabIds: stray, activeTabId: stray[0], width: WIN_W });
  }
  // every window has its own colour (one no other window uses, if possible), and its tabs share it
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const used = new Set<number>();
  const coloured = wins.map((w) => {
    let c = w.color;
    if (c === undefined || used.has(c)) {
      const own = byId.get(w.activeTabId)?.color;
      c = own !== undefined && !used.has(own) ? own : (Array.from({ length: THREAD_COLORS.length }, (_, i) => i).find((i) => !used.has(i)) ?? 0);
    }
    used.add(c);
    return c === w.color ? w : { ...w, color: c };
  });
  const colourOf = new Map(coloured.flatMap((w) => w.tabIds.map((t) => [t, w.color!] as const)));
  const tinted = tabs.map((t) => (colourOf.has(t.id) && colourOf.get(t.id) !== t.color ? { ...t, color: colourOf.get(t.id)! } : t));
  const aw = coloured.find((w) => w.id === activeWindowId) ?? coloured[coloured.length - 1] ?? null;
  return { tabs: tinted, windows: coloured, activeWindowId: aw?.id ?? null, activeTabId: aw?.activeTabId ?? null };
}

/**
 * Add streamed text to the end of a message, growing its last span (the stream's). Tokens are
 * placed from that span's start: they may cover text that arrived in an earlier chunk.
 */
function appendGen(m: Message, text: string, toks?: PlacedToken[]): Message {
  const spans = m.spans?.slice() ?? [];
  const last = spans[spans.length - 1];
  const base = last ? last.s : m.text.length;
  if (last) spans[spans.length - 1] = { ...last, e: m.text.length + text.length };
  const add: TokInfo[] = (toks ?? []).map((k) => ({ o: base + k.o, t: k.t, lp: k.lp, ...(k.top ? { top: k.top } : {}) }));
  return { ...m, text: m.text + text, toks: add.length ? [...(m.toks ?? []), ...add] : m.toks, spans: spans.length ? spans : undefined };
}

// ---------- store ----------

export const useLoom = create<LoomState>()((set, get) => {
  const bump = () => get().structure + 1;

  const dropStream = (key: string) => {
    streams.delete(key);
    targets.delete(key);
  };
  const syncOrder = () => set({ streamOrder: pageOrder() });

  const snap = (): Snapshot => {
    const s = get();
    return { nodes: s.nodes, children: s.children, tabs: s.tabs, windows: s.windows, activeWindowId: s.activeWindowId };
  };

  /** Restore a snapshot, but keep text that has streamed in since it was taken. */
  const restore = (sn: Snapshot) => {
    const cur = get().nodes;
    const nodes: Nodes = { ...sn.nodes };
    for (const [id, n] of Object.entries(sn.nodes)) {
      if (!n.messages.some((m) => m.generating)) continue;
      const now = cur[id];
      nodes[id] = {
        ...n,
        messages: n.messages.map((m, i) => {
          if (!m.generating) return m;
          const live = now?.messages[i];
          if (live && live.role === m.role) return live;
          return { ...m, generating: streams.has(streamKey(id, i)) };
        }),
      };
    }
    for (const [key, h] of streams) {
      const [id, i] = key.split(':');
      if (!nodes[id]?.messages[Number(i)]) {
        h.cancel();
        dropStream(key);
      }
    }
    syncOrder();
    // the snapshot's tabs and windows, keeping any renames made since
    const now = new Map(get().tabs.map((t) => [t.id, t]));
    const tabs = sn.tabs.map((t) => ({ ...t, name: now.get(t.id)?.name ?? t.name, headId: nodes[t.headId] ? t.headId : get().rootId }));
    set({ nodes, children: sn.children, ...settleWindows(tabs, sn.windows, sn.activeWindowId), structure: bump() });
  };

  const patchMessage = (id: string, msg: number, fn: (m: Message) => Message) =>
    set((s) => {
      const n = s.nodes[id];
      const m = n?.messages[msg];
      if (!m) return {};
      const messages = n.messages.slice();
      messages[msg] = fn(m);
      return { nodes: { ...s.nodes, [id]: { ...n, messages } } };
    });

  /** A generation is over (finished, failed or stopped). A message that never got a word is taken back: no message is empty. */
  const endStream = (at: { id: string; msg: number }) => {
    dropStream(streamKey(at.id, at.msg));
    const node = get().nodes[at.id];
    const m = node?.messages[at.msg];
    if (node && m && !m.text && at.msg === node.messages.length - 1)
      set((st) => ({ nodes: { ...st.nodes, [at.id]: { ...node, messages: node.messages.slice(0, -1) } }, structure: st.structure + 1 }));
    else patchMessage(at.id, at.msg, (x) => ({ ...x, generating: false }));
    syncOrder();
  };

  /**
   * Stream the model's words into nodes[id].messages[msg], the last message of the conversation
   * at `id`. What it reads is fixed now, also when it has to wait its turn. `prefer` names a model
   * (by label) to use if it is switched on. `at` follows the message if a split above moves it.
   */
  const startStream = (id: string, msg: number, prefer?: string) => {
    const nodes = get().nodes;
    const own = nodes[id]?.messages[msg];
    if (!own) return;
    const at = { id, msg };
    const profile = pickModel(prefer);
    if (!profile) {
      endStream(at);
      get().showToast('No model is switched on. Open settings (the gear, top right) to pick one.');
      return;
    }
    const pieces = piecesFor(nodes, id);
    const turns = turnsFor(nodes, id);
    // demo only: carrying on text that doesn't end in a space starts with one
    const prev = own.text ? { role: own.role, text: own.text } : pieces[pieces.length - 2];
    const leadingSpace = !!prev && (own.text ? true : prev.role === own.role) && prev.text.length > 0 && !/\s$/.test(prev.text);
    // a message that starts a turn of its own drops the whitespace a model writes after "Assistant:"
    const trimStart = !turns[turns.length - 1]?.text;
    const st = useSettings.getState();
    const span: Span = { s: own.text.length, e: own.text.length, model: profile.label, at: Date.now(), temp: st.sampling.temperature };
    patchMessage(id, msg, (m) => ({ ...m, generating: true, spans: [...(m.spans ?? []), span] }));
    const statusKey = () => streamKey(at.id, at.msg);
    const h = generate(
      { turns, profile, sampling: st.sampling, format: st.format, apiKey: apiKeyFor(profile), leadingSpace, trimStart, onStatus: (t) => setStatus(statusKey(), t) },
      (text, toks) => {
        setStatus(statusKey(), null);
        patchMessage(at.id, at.msg, (m) => (m.generating ? appendGen(m, text, toks) : m));
      },
      (info) => {
        setStatus(statusKey(), null);
        patchMessage(at.id, at.msg, (m) => {
          // the stream's span is the last one; drop it if nothing was written
          const spans = (m.spans ?? []).slice();
          const last = spans[spans.length - 1];
          if (last && last.at === span.at) {
            if (last.e <= last.s) spans.pop();
            else spans[spans.length - 1] = { ...last, ...(info.finish ? { finish: info.finish } : {}) };
          }
          return { ...m, spans: spans.length ? spans : undefined };
        });
        endStream(at);
        if (info.error) get().showToast(`Generation failed: ${info.error}`);
      },
    );
    if (profile.mode === 'browser') inPage.add(at);
    streams.set(streamKey(id, msg), h);
    targets.set(streamKey(id, msg), at);
    syncOrder();
  };

  const addChild = (parentId: string, forkAt: ForkAt | null, messages: Message[], pos?: { x: number; y: number }) => {
    const s = get();
    const id = uid('n');
    const p = pos ? { ...pos } : placeChild(s.nodes, s.children, parentId);
    // a node dropped onto another one is nudged sideways until it is clear
    let guard = 0;
    while (pos && overlaps(s.nodes, p.x, p.y) && guard++ < 200) p.x += NODE_W / 2 + GAP_X / 2;
    set({
      nodes: { ...s.nodes, [id]: { id, parentId, forkAt, messages, x: p.x, y: p.y, hidden: false } },
      children: { ...s.children, [parentId]: [...(s.children[parentId] ?? []), id], [id]: [] },
      structure: bump(),
    });
    return id;
  };

  /**
   * Split node `id` at (msg, offset). The node keeps everything before that point; a new child
   * takes the rest (and the children forked from the rest). Children forked exactly at the
   * split point stay on the node, now cut at its end. Chats on the node move to the new child.
   */
  const splitNode = (id: string, msg: number, offset: number): string => {
    const s = get();
    const N = s.nodes[id];
    const m = N.messages[msg];
    const before: Message[] = [...N.messages.slice(0, msg), ...(offset > 0 ? [sliceGen(m, 0, offset)] : [])];
    const partial = offset < m.text.length; // does the suffix start part-way through message `msg`?
    const after: Message[] = [...(partial ? [sliceGen(m, offset)] : []), ...N.messages.slice(msg + 1)];
    const sufId = uid('n');
    const shift = NODE_H + GAP_Y;
    const nodes: Nodes = { ...s.nodes };
    for (const d of descendants(s.children, id)) nodes[d] = { ...nodes[d], y: nodes[d].y + shift };
    nodes[id] = { ...N, messages: before };
    const prefixEnd = endOf(nodes[id]);
    const keep: string[] = [];
    const move: string[] = [];
    for (const c of s.children[id] ?? []) {
      const f = nodes[c].forkAt;
      if (!f) {
        keep.push(c);
        continue;
      }
      const isBefore = f.msg < msg || (f.msg === msg && f.offset < offset);
      const isAt = f.msg === msg && f.offset === offset;
      if (isBefore) keep.push(c);
      else if (isAt) {
        keep.push(c);
        nodes[c] = { ...nodes[c], forkAt: prefixEnd };
      } else {
        move.push(c);
        const fm = f.msg === msg ? { msg: 0, offset: f.offset - offset } : { msg: f.msg - msg - (partial ? 0 : 1), offset: f.offset };
        nodes[c] = { ...nodes[c], parentId: sufId, forkAt: fm };
      }
    }
    nodes[sufId] = { id: sufId, parentId: id, forkAt: prefixEnd, messages: after, x: N.x, y: N.y + shift, hidden: false };
    const children = { ...s.children, [id]: [sufId, ...keep], [sufId]: move };
    // a chat standing on the whole node keeps seeing the whole text
    const tabs = s.tabs.map((t) => (t.headId === id ? { ...t, headId: sufId } : t));
    // a message still being written in the part that moved keeps getting its words
    const live = [...streams].map(([key, h]) => {
      const at = targets.get(key)!;
      if (at.id === id && (at.msg > msg || (at.msg === msg && partial))) {
        at.id = sufId;
        at.msg -= msg + (partial ? 0 : 1);
      }
      return [streamKey(at.id, at.msg), h, at] as const;
    });
    streams.clear();
    targets.clear();
    for (const [key, h, at] of live) {
      streams.set(key, h);
      targets.set(key, at);
    }
    set({ nodes, children, tabs, structure: s.structure + 1, streamOrder: pageOrder() });
    return sufId;
  };

  /** focus a tab: it shows in its window, and that window becomes the one you're in */
  const focusTab = (tabId: string) =>
    set((s) => {
      const w = s.windows.find((x) => x.tabIds.includes(tabId));
      if (!w) return {};
      const windows = s.windows.map((x) => (x.id === w.id ? { ...x, activeTabId: tabId } : x));
      return { windows, activeWindowId: w.id, activeTabId: tabId, structure: s.structure + 1 };
    });

  const setHead = (tabId: string, headId: string) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, headId } : t)), structure: s.structure + 1 }));
    focusTab(tabId);
  };

  const applyTabs = (tabs: Tab[], windows: Win[], activeWindowId: string | null) =>
    set((s) => ({ ...settleWindows(tabs, windows, activeWindowId), structure: s.structure + 1 }));

  /**
   * Open a new tab on a node: next to the current tab of the window you're in, or in a new window
   * (if fewer than MAX_WINDOWS are open; otherwise it falls back to a tab and says why).
   */
  const addTab = (headId: string, where: 'tab' | 'window' = 'tab'): string => {
    const s = get();
    const tab: Tab = { id: uid('t'), name: '', headId, color: s.colorCounter % THREAD_COLORS.length };
    let windows = s.windows;
    let into = s.windows.find((w) => w.id === s.activeWindowId) ?? s.windows[s.windows.length - 1];
    if (where === 'window' && s.windows.length >= MAX_WINDOWS) {
      s.showToast(`You can have ${MAX_WINDOWS} windows open at once, so this opened as a tab.`);
      where = 'tab';
    }
    if (where === 'window' || !into) {
      const w: Win = { id: uid('w'), tabIds: [tab.id], activeTabId: tab.id, width: WIN_W };
      const at = into ? s.windows.indexOf(into) + 1 : s.windows.length;
      windows = [...s.windows.slice(0, at), w, ...s.windows.slice(at)];
      into = w;
    } else {
      const i = into.tabIds.indexOf(into.activeTabId);
      const tabIds = [...into.tabIds.slice(0, i + 1), tab.id, ...into.tabIds.slice(i + 1)];
      windows = s.windows.map((w) => (w.id === into!.id ? { ...w, tabIds, activeTabId: tab.id } : w));
    }
    set({
      ...settleWindows([...s.tabs, tab], windows, into.id),
      tabCounter: s.tabCounter + 1,
      colorCounter: s.colorCounter + 1,
      sidebarFolded: false,
      structure: bump(),
    });
    return tab.id;
  };

  const loaded = load() ?? seed();
  const initial = { ...loaded, ...settleWindows(loaded.tabs, loaded.windows, loaded.activeWindowId) };

  return {
    ...initial,
    structure: 0,
    streamOrder: [],
    focusRequest: null,
    toast: null,
    past: [],
    future: [],

    commit() {
      set((s) => ({ past: [...s.past.slice(-199), snap()], future: [] }));
    },

    undo() {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      const now = snap();
      set({ past: s.past.slice(0, -1), future: [...s.future, now] });
      restore(prev);
    },

    redo() {
      const s = get();
      const next = s.future[s.future.length - 1];
      if (!next) return;
      const now = snap();
      set({ future: s.future.slice(0, -1), past: [...s.past, now] });
      restore(next);
    },

    forkGenerate(nodeId, opts = {}) {
      const N = get().nodes[nodeId];
      if (!N) return '';
      get().commit();
      if (N.isRoot) {
        // the model never speaks first: a branch off the root starts as your (empty) message
        const id = addChild(nodeId, null, [], opts.pos);
        get().openInChat(id, true);
        return id;
      }
      const id = addChild(nodeId, opts.at ?? endOf(N), [{ role: 'model', text: '', generating: true }], opts.pos);
      startStream(id, 0);
      return id;
    },

    forkMany(nodeId, count) {
      if (get().nodes[nodeId]?.isRoot) count = 1;
      for (let i = 0; i < count; i++) get().forkGenerate(nodeId);
    },

    forkForWriting(nodeId, pos) {
      const N = get().nodes[nodeId];
      if (!N) return;
      get().commit();
      const id = addChild(nodeId, endOf(N), [], pos);
      get().openInChat(id, true);
    },

    forkAtPoint(tabId, nodeId, msg, offset, kind, count = 1) {
      const N = get().nodes[nodeId];
      if (!N?.messages[msg]) return;
      if (N.messages[msg].generating) {
        get().showToast('Wait for this message to finish (or stop it) before forking after it');
        return;
      }
      get().commit();
      // the model writes the next message: the other voice to the one the fork comes after
      let voice = otherRole(N.messages[msg].role);
      let parent = nodeId;
      let at: ForkAt | null;
      const len = N.messages[msg].text.length;
      const atEnd = msg === N.messages.length - 1 && offset >= len;
      if (msg === 0 && offset <= 0 && N.parentId) {
        // forking at the node's first token: a sibling, cut from the parent where this node is
        parent = N.parentId;
        at = N.forkAt;
        // another take on this node's first message, in its voice
        voice = N.messages[0].role;
      } else if (atEnd) {
        at = endOf(N);
      } else {
        // forking inside the node: split it, so the text before the token becomes the parent
        // and the old continuation and the new fork are its two children
        splitNode(nodeId, msg, offset);
        at = endOf(get().nodes[nodeId]);
        // from a word the model carries on (its own message, or its answer to yours cut there);
        // from a message's first word it is another take on that message, in its voice
        voice = offset > 0 ? 'model' : N.messages[msg].role;
      }
      let id = '';
      for (let i = 0; i < (kind === 'generate' ? count : 1); i++) {
        id =
          kind === 'generate'
            ? addChild(parent, at, [{ role: voice, text: '', generating: true }])
            : addChild(parent, at, []);
        if (kind === 'generate') startStream(id, 0);
      }
      setHead(tabId, id);
      if (kind === 'write') set({ focusRequest: { tabId, n: Date.now() } });
    },

    sendMessage(tabId, text, role = 'user', auto = true) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      const body = text.trim();
      if (!tab || !body) return;
      const head = s.nodes[tab.headId] ?? s.nodes[s.rootId];
      if (head.messages.some((m) => m.generating)) return;
      s.commit();
      const reply: Message[] = auto ? [{ role: otherRole(role), text: '', generating: true }] : [];
      let id = head.id;
      if (head.isRoot) {
        // the root holds no text: the first message starts a new node under it
        id = addChild(head.id, null, [{ role, text: body }, ...reply]);
      } else {
        // (an empty last message is a leftover of the old ‹u› / ‹as› tokens: dropped)
        const tail = head.messages[head.messages.length - 1];
        const base = tail && !tail.text ? head.messages.slice(0, -1) : head.messages;
        const last = base[base.length - 1];
        // the text this follows: the node's last message, or in a new branch the message it was cut from
        const before = last ?? piecesFor(s.nodes, head.id).pop();
        // one voice never has two messages in a row: the same voice again joins the message before, on a new line
        const joins = before?.role === role;
        const sep = joins && before.text && !/\s$/.test(before.text) ? '\n' : '';
        const written: Message[] = last && joins ? [...base.slice(0, -1), { ...last, text: last.text + sep + body }] : [...base, { role, text: sep + body }];
        set((st) => ({ nodes: { ...st.nodes, [head.id]: { ...head, messages: [...written, ...reply] } }, structure: st.structure + 1 }));
      }
      setHead(tabId, id);
      if (auto) startStream(id, get().nodes[id].messages.length - 1);
    },

    promptModel(tabId, role) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const head = s.nodes[tab.headId] ?? s.nodes[s.rootId];
      if (head.messages.some((m) => m.generating)) return;
      s.commit();
      if (head.isRoot) {
        const id = addChild(head.id, null, [{ role, text: '', generating: true }]);
        setHead(tabId, id);
        startStream(id, 0);
        return;
      }
      const i = head.messages.length - 1;
      // an empty branch gets its first message; in the voice of the message it was cut from, that one is carried on
      const messages: Message[] =
        i >= 0 && head.messages[i].role === role
          ? head.messages.map((m, k) => (k === i ? { ...m, generating: true } : m))
          : [...head.messages, { role, text: '', generating: true }];
      set((st) => ({ nodes: { ...st.nodes, [head.id]: { ...head, messages } }, structure: st.structure + 1 }));
      startStream(head.id, messages.length - 1);
    },

    stopGenerating(tabId) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      for (const p of piecesFor(s.nodes, tab.headId)) {
        if (!p.generating) continue;
        streams.get(streamKey(p.nodeId, p.msg))?.cancel();
        endStream({ id: p.nodeId, msg: p.msg });
      }
    },

    deleteSubtree(id) {
      const s = get();
      const N = s.nodes[id];
      if (!N || !N.parentId) return;
      s.commit();
      const gone = new Set([id, ...descendants(s.children, id)]);
      const nodes: Nodes = {};
      const children: Kids = {};
      for (const [k, v] of Object.entries(s.nodes)) if (!gone.has(k)) nodes[k] = v;
      for (const [k, v] of Object.entries(s.children)) if (!gone.has(k)) children[k] = v;
      children[N.parentId] = children[N.parentId].filter((c) => c !== id);
      for (const [key, h] of streams) {
        if (gone.has(key.split(':')[0])) {
          h.cancel();
          dropStream(key);
        }
      }
      syncOrder();
      // chats that were on a deleted node close with it
      const tabs = s.tabs.filter((t) => !gone.has(t.headId));
      set({ nodes, children, ...settleWindows(tabs, s.windows, s.activeWindowId), structure: bump() });
    },

    hideNode(id) {
      const s = get();
      const N = s.nodes[id];
      if (!N || !N.parentId) return;
      s.commit();
      set({ nodes: { ...s.nodes, [id]: { ...N, hidden: true } }, structure: bump() });
    },

    showAllBelow(id) {
      const s = get();
      s.commit();
      const nodes = { ...s.nodes };
      for (const d of descendants(s.children, id)) if (nodes[d].hidden) nodes[d] = { ...nodes[d], hidden: false };
      set({ nodes, structure: bump() });
    },

    moveNode(id, x, y) {
      const s = get();
      const N = s.nodes[id];
      if (!N) return;
      set({ nodes: { ...s.nodes, [id]: { ...N, x, y } }, structure: bump() });
    },

    moveNodes(pos) {
      set((s) => {
        const nodes = { ...s.nodes };
        for (const [id, p] of Object.entries(pos)) if (nodes[id]) nodes[id] = { ...nodes[id], x: p.x, y: p.y };
        return { nodes, structure: s.structure + 1 };
      });
    },

    deleteNodes(ids) {
      const s = get();
      const roots = ids.filter((id) => s.nodes[id] && !s.nodes[id].isRoot);
      if (!roots.length) return;
      s.commit();
      const gone = new Set<string>();
      for (const id of roots) {
        gone.add(id);
        for (const d of descendants(s.children, id)) gone.add(d);
      }
      const nodes: Nodes = {};
      const children: Kids = {};
      for (const [k, v] of Object.entries(s.nodes)) if (!gone.has(k)) nodes[k] = v;
      for (const [k, v] of Object.entries(s.children)) if (!gone.has(k)) children[k] = v.filter((c) => !gone.has(c));
      for (const [key, h] of streams) {
        if (gone.has(key.split(':')[0])) {
          h.cancel();
          dropStream(key);
        }
      }
      syncOrder();
      const tabs = s.tabs.filter((t) => !gone.has(t.headId));
      set({ nodes, children, ...settleWindows(tabs, s.windows, s.activeWindowId), structure: bump() });
    },

    hideNodes(ids) {
      const s = get();
      const hide = ids.filter((id) => s.nodes[id] && !s.nodes[id].isRoot);
      if (!hide.length) return;
      s.commit();
      const nodes = { ...s.nodes };
      for (const id of hide) nodes[id] = { ...nodes[id], hidden: true };
      set({ nodes, structure: bump() });
    },

    tidy() {
      const s = get();
      s.commit();
      set({ nodes: tidyPositions(s.nodes, s.children, s.rootId), structure: bump() });
    },

    openInChat(id, focusInput) {
      const s = get();
      // prefer a tab already on this node: the showing one, else any
      const shown = new Set(visibleTabs(s).map((t) => t.id));
      const existing = s.tabs.find((t) => t.headId === id && shown.has(t.id)) ?? s.tabs.find((t) => t.headId === id);
      let tabId: string;
      if (existing) {
        tabId = existing.id;
        focusTab(tabId);
        set({ sidebarFolded: false });
      } else tabId = addTab(id);
      if (focusInput) set({ focusRequest: { tabId, n: Date.now() } });
    },

    openNodeIn(id, where) {
      const s = get();
      if (!s.nodes[id]) return;
      const existing = s.tabs.find((t) => t.headId === id);
      if (!existing) {
        addTab(id, where);
        return;
      }
      // already open: in a new window means moving its tab there, otherwise just show it
      const w = s.windows.find((x) => x.tabIds.includes(existing.id));
      if (where === 'window' && w && w.tabIds.length > 1 && s.windows.length < MAX_WINDOWS) get().moveTab(existing.id, 'new');
      else focusTab(existing.id);
      set({ sidebarFolded: false });
    },

    newTab() {
      const id = addTab(get().rootId);
      set({ focusRequest: { tabId: id, n: Date.now() } });
    },

    closeTab(id) {
      const s = get();
      // like a browser: the tab to the right takes its place, else the one to the left
      const windows = s.windows.map((w) => {
        if (!w.tabIds.includes(id)) return w;
        const i = w.tabIds.indexOf(id);
        const tabIds = w.tabIds.filter((t) => t !== id);
        const next = w.activeTabId === id ? (tabIds[i] ?? tabIds[i - 1]) : w.activeTabId;
        return { ...w, tabIds, activeTabId: next };
      });
      applyTabs(s.tabs.filter((t) => t.id !== id), windows, s.activeWindowId);
    },

    closeTabsToRight(id) {
      const s = get();
      const w = s.windows.find((x) => x.tabIds.includes(id));
      if (!w) return;
      const keep = w.tabIds.slice(0, w.tabIds.indexOf(id) + 1);
      const drop = new Set(w.tabIds.filter((t) => !keep.includes(t)));
      const windows = s.windows.map((x) => (x.id === w.id ? { ...x, tabIds: keep, activeTabId: keep.includes(x.activeTabId) ? x.activeTabId : id } : x));
      applyTabs(s.tabs.filter((t) => !drop.has(t.id)), windows, w.id);
    },

    closeWindow(id) {
      const s = get();
      const w = s.windows.find((x) => x.id === id);
      if (!w) return;
      const drop = new Set(w.tabIds);
      const i = s.windows.indexOf(w);
      const rest = s.windows.filter((x) => x.id !== id);
      const nextActive = s.activeWindowId === id ? (rest[i] ?? rest[i - 1])?.id ?? null : s.activeWindowId;
      applyTabs(s.tabs.filter((t) => !drop.has(t.id)), rest, nextActive);
    },

    moveTab(tabId, to) {
      const s = get();
      const from = s.windows.find((x) => x.tabIds.includes(tabId));
      if (!from) return;
      if (to === 'new') {
        if (from.tabIds.length === 1) return; // it is already a window of its own
        if (s.windows.length >= MAX_WINDOWS) {
          s.showToast(`You can have ${MAX_WINDOWS} windows open at once.`);
          return;
        }
        const w: Win = { id: uid('w'), tabIds: [tabId], activeTabId: tabId, width: WIN_W };
        const windows = s.windows.map((x) => (x.id === from.id ? { ...x, tabIds: x.tabIds.filter((t) => t !== tabId), activeTabId: x.activeTabId === tabId ? '' : x.activeTabId } : x));
        const at = windows.findIndex((x) => x.id === from.id) + 1;
        applyTabs(s.tabs, [...windows.slice(0, at), w, ...windows.slice(at)], w.id);
        return;
      }
      const target = s.windows.find((x) => x.id === to.windowId);
      if (!target) return;
      let windows = s.windows.map((x) => (x.id === from.id ? { ...x, tabIds: x.tabIds.filter((t) => t !== tabId), activeTabId: x.activeTabId === tabId && x.id !== target.id ? '' : x.activeTabId } : x));
      windows = windows.map((x) => {
        if (x.id !== target.id) return x;
        const index = Math.max(0, Math.min(to.index, x.tabIds.length));
        return { ...x, tabIds: [...x.tabIds.slice(0, index), tabId, ...x.tabIds.slice(index)], activeTabId: tabId };
      });
      applyTabs(s.tabs, windows, target.id);
    },

    setActiveTab(id) {
      const s = get();
      const w = s.windows.find((x) => x.tabIds.includes(id));
      if (s.activeTabId !== id || w?.activeTabId !== id) focusTab(id);
    },

    resizeWindow(id, width) {
      set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, width } : w)) }));
    },

    renameTab(id, name) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name: name.trim() } : t)) }));
    },

    toggleSidebar() {
      set((s) => ({ sidebarFolded: !s.sidebarFolded }));
    },

    goToNode(tabId, nodeId) {
      const s = get();
      if (!s.nodes[nodeId]) return;
      // a node never has two tabs: if another tab already shows it, switch to that one
      const other = s.tabs.find((t) => t.headId === nodeId && t.id !== tabId);
      if (other) focusTab(other.id);
      else setHead(tabId, nodeId);
    },

    showToast(text) {
      set({ toast: { text, n: Date.now() } });
    },

    reset() {
      for (const h of streams.values()) h.cancel();
      streams.clear();
      targets.clear();
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        /* storage unavailable */
      }
      set({ ...seed(), past: [], future: [], streamOrder: [], structure: get().structure + 1 });
    },
  };
});

// debounced save
let saveTimer: number | undefined;
useLoom.subscribe((s) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const { nodes, children, rootId, tabs, windows, activeWindowId, activeTabId, sidebarFolded, tabCounter, colorCounter } = s;
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ nodes, children, rootId, tabs, windows, activeWindowId, activeTabId, sidebarFolded, tabCounter, colorCounter }),
      );
    } catch {
      /* storage unavailable */
    }
  }, 500);
});

// ---------- small UI store (transient, high-frequency) ----------

interface UiState {
  /** x/y: the cursor position (viewport) the menu or tooltip opens next to */
  menu: { nodeId: string; x: number; y: number } | null;
  hover: { nodeId: string; x: number; y: number } | null;
  forkDrag: { fromId: string; x: number; y: number } | null;
  /** canvas tool: the arrow selects and moves nodes, the hand only pans */
  tool: 'select' | 'hand';
  /** holding space switches to the hand for as long as it's held */
  spaceHand: boolean;
  /** a node hovered from somewhere else (a branch box in the chat): it shows the canvas hover outline */
  linkHover: string | null;
  /** the nodes picked with the arrow tool */
  selection: string[];
  /** what the server says while a generation waits to start, by `${nodeId}:${msg}` */
  status: Record<string, string>;
  /** a box being dragged out with the arrow tool, in canvas-element pixels */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  /** a tab being dragged, and where it would land */
  tabDrag: {
    tabId: string;
    x: number;
    y: number;
    target: { windowId: string; index: number } | 'new' | 'blocked' | null;
  } | null;
  set(p: Partial<Omit<UiState, 'set'>>): void;
}

export const useUi = create<UiState>()((set) => ({
  menu: null,
  hover: null,
  forkDrag: null,
  tabDrag: null,
  tool: 'select',
  spaceHand: false,
  selection: [],
  marquee: null,
  linkHover: null,
  status: {},
  set: (p) => set(p),
}));

function setStatus(key: string, text: string | null) {
  const cur = useUi.getState().status;
  if ((cur[key] ?? null) === text) return;
  const status = { ...cur };
  if (text === null) delete status[key];
  else status[key] = text;
  useUi.getState().set({ status });
}

export function exportMarkdown(nodes: Nodes, id: string): string {
  const out: string[] = [];
  let role: Role | null = null;
  let buf = '';
  const flush = () => {
    if (role) out.push(`### ${role}\n\n${buf.trim()}\n`);
  };
  for (const p of piecesFor(nodes, id)) {
    if (p.role !== role) {
      flush();
      role = p.role;
      buf = '';
    }
    buf += p.text;
  }
  flush();
  return out.join('\n');
}

// with ?debug in the URL, expose the stores for automated checks
if (typeof window !== 'undefined' && window.location.search.includes('debug')) {
  (window as unknown as { __loomUi: typeof useUi }).__loomUi = useUi;
  (window as unknown as { __loom: typeof useLoom }).__loom = useLoom;
}
