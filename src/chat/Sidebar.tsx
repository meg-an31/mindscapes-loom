import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { MAX_WINDOWS, colorOf, divergingToken, lastVoice, pathTo, piecesFor, useLoom, useUi, type Role, type Tab, type Win } from '../store';
import { useIsMobile } from '../useIsMobile';
import { tokenize } from '../text';
import { SidebarToggle } from '../Chrome';
import { TOOLTIP_DELAY_MS, TOOLTIP_GAP, useNearCursor } from '../floating';
import { Flyout } from '../Flyout';
import { forkMarks, markKey, type Branch, type Bubble } from './forkMarks';
import { useChatPrefs, voiceFor, type TypeAs } from './prefs';
import robotLines from '../assets/robot-lines.png';

const MIN_W = 240;
/** the chat options menu's width (.chat-menu) */
const CHAT_MENU_W = 276;
const MAX_W = 720;

/** how many other branches split at a point of the chat, by `markKey` (see forkMarks) */
type ForkCounts = Map<string, number>;

/**
 * The conversation as bubbles. One bubble is everything one voice says before the other speaks:
 * pieces in the same voice always join, whatever nodes they sit in, so no voice ever has two
 * bubbles in a row (the model reads it the same way, see bubblesOf and turnsFor in the store). A message with no words is not
 * drawn, unless the model is about to write it.
 */
function useConversation(headId: string) {
  const nodes = useLoom((s) => s.nodes);
  const children = useLoom((s) => s.children);
  return useMemo(() => {
    const bubbles: Bubble[] = [];
    for (const p of piecesFor(nodes, headId)) {
      if (!p.text && !p.generating) continue;
      const last = bubbles[bubbles.length - 1];
      if (last && last.role === p.role) last.pieces.push(p);
      else bubbles.push({ role: p.role, pieces: [p] });
    }
    const { counts: forks, kids: forkKids } = forkMarks(pathTo(nodes, headId), nodes, children, bubbles);
    return { bubbles, forks, forkKids };
  }, [nodes, children, headId]);
}

/** A place in the tree that the chat can fork at. */
interface TreePoint {
  nodeId: string;
  msg: number;
  offset: number;
}

/**
 * The space between two bubbles (and above the first, below the last) is a point of the text:
 * a thin line shows there under the mouse, and a click opens the fork menu. The line stays, with
 * a count, where other branches already part. `quiet`: those branches are listed right there (the
 * tree under the chat's last message), so the line is not lit for them a second time.
 */
function Gap({ at, top, branches, quiet }: { at: TreePoint; top?: boolean; branches: number; quiet?: boolean }) {
  const lit = branches > 0 && !quiet;
  return (
    <button
      type="button"
      className={`gap${lit ? ' loomed' : ''}`}
      data-n={at.nodeId}
      data-m={at.msg}
      data-o={at.offset}
      data-top={top || undefined}
      data-b={branches || undefined}
      data-tip="click to fork here"
      aria-label={`fork here${branches ? ` (${branches} branch${branches > 1 ? 'es' : ''} already split here)` : ''}`}
    >
      {lit && <span className="gap-n">{branches}</span>}
    </button>
  );
}

/**
 * The robot with a speech bubble: the model writes here, in this voice. The assistant's are on the
 * left of the chat and the user's on the right, like the bubbles. It always takes its room and is
 * only shown while the mouse is over its side of the chat (see .msgs[data-side]; 70% to the voice that spoke last), so nothing
 * moves when it appears.
 */
function RobotButton({ tabId, voice, off }: { tabId: string; voice: Role; off: boolean }) {
  const tip = `click to start model response as the ${voice === 'model' ? 'assistant' : 'user'}`;
  return (
    <button
      type="button"
      className={`robot-btn ${voice === 'model' ? 'left' : 'right'}`}
      data-voice={voice}
      data-tip={tip}
      aria-label={tip}
      disabled={off}
      onClick={(e) => {
        e.stopPropagation();
        useLoom.getState().promptModel(tabId, voice);
      }}
    >
      <span className="robot-ico" style={{ maskImage: `url(${robotLines})`, WebkitMaskImage: `url(${robotLines})` }} />
      {/* drawn as thin as the robot's own lines */}
      <svg className="robot-says" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** What the server says while a generation waits to start (a model booting, a queue). */
function GenStatus({ bubble }: { bubble: Bubble }) {
  const p = bubble.pieces.find((x) => x.generating);
  const text = useUi((s) => (p ? s.status[`${p.nodeId}:${p.msg}`] : undefined));
  if (!text) return null;
  return <span className="gen-status">{text}</span>;
}

const BubbleView = memo(function BubbleView({ bubble, forks, waiting, tail }: { bubble: Bubble; forks: ForkCounts; waiting?: boolean; tail?: ReactNode }) {
  const generating = bubble.pieces.some((p) => p.generating);
  return (
    <div className={`bubble ${bubble.role}`}>
      <p>
        {bubble.pieces.map((p) => {
          const base = `${p.nodeId}:${p.msg}:`;
          return tokenize(p.text).map((tok) => {
            if (tok.space) return tok.text;
            // a word is lit where another branch parts in the middle of a message
            const n = forks.get(base + tok.offset) ?? 0;
            return (
              <span
                key={`${base}${tok.offset}`}
                className={`tok${n ? ' loomed' : ''}`}
                data-n={p.nodeId}
                data-m={p.msg}
                data-o={tok.offset}
                data-b={n || undefined}
              >
                {tok.text}
              </span>
            );
          });
        })}
        {generating && (waiting ? <span className="waiting">waiting for its turn…</span> : <span className="caret" aria-hidden="true" />)}
        {generating && !waiting && <GenStatus bubble={bubble} />}
        {tail}
      </p>
    </div>
  );
});

const NO_KIDS = '';
const TREE_TOKENS_MIN = 4;
const TREE_TOKENS_MAX = 8;

/**
 * The branches that carry on from the end of the conversation, Reddit-thread style: a line drops
 * from the last message and runs along a horizontally scrolling row of boxes, one per branch.
 * Each box lists that branch's next tokens top to bottom, up to a few past the first token where
 * the branches stop agreeing (not highlighted: in the chat, the highlight means "branches split
 * here", which these words aren't). Click a box to go to that branch.
 */
/**
 * Hovering something in the chat that stands for a node outlines that node on the canvas. The
 * outline is cleared on mouse-leave and also when the thing disappears under the mouse (a tab
 * closed with its ×, a list row picked), which never fires mouse-leave.
 */
function useLinkHover(id: string) {
  const over = useRef(false);
  useEffect(
    () => () => {
      if (over.current && useUi.getState().linkHover === id) useUi.getState().set({ linkHover: null });
      over.current = false;
    },
    [id],
  );
  return {
    onMouseEnter: () => {
      over.current = true;
      useUi.getState().set({ linkHover: id });
    },
    onMouseLeave: () => {
      over.current = false;
      if (useUi.getState().linkHover === id) useUi.getState().set({ linkHover: null });
    },
  };
}

function ForkTree({ kids, onPick }: { kids: string[]; onPick: (id: string) => void }) {
  const nodes = useLoom((s) => s.nodes);
  const lists = kids.map((id) => {
    const n = nodes[id];
    const words = tokenize((n?.messages.map((m) => m.text).join(' ') ?? '').trim())
      .filter((t) => !t.space)
      .map((t) => t.text);
    return { id, role: n?.messages[0]?.role ?? null, words, generating: !!n?.messages.some((m) => m.generating) };
  });
  // first index where the branches differ
  let div = 0;
  const longest = Math.max(...lists.map((l) => l.words.length), 0);
  while (div < longest && lists.every((l) => l.words[div] !== undefined && l.words[div] === lists[0].words[div])) div++;
  const show = Math.min(TREE_TOKENS_MAX, Math.max(TREE_TOKENS_MIN, div + 4));
  const kidsKey = kids.join(',');
  useEffect(
    () => () => {
      const h = useUi.getState().linkHover;
      if (h && kidsKey.split(',').includes(h)) useUi.getState().set({ linkHover: null });
    },
    [kidsKey],
  );
  return (
    <div className="fork-tree" role="list" aria-label={`${kids.length} branch${kids.length > 1 ? 'es' : ''} continue from here`}>
      {lists.map((l) => (
        <div key={l.id} className="fork-item" role="listitem">
          <button
            type="button"
            className={`fork-box ${l.role ?? 'empty'}`}
            onClick={() => {
              useUi.getState().set({ linkHover: null });
              onPick(l.id);
            }}
            onMouseEnter={() => useUi.getState().set({ linkHover: l.id })}
            onMouseLeave={() => useUi.getState().linkHover === l.id && useUi.getState().set({ linkHover: null })}
            title="go to this branch"
          >
            {l.words.length === 0 ? (
              <span className="fork-word muted">{l.generating ? 'weaving…' : 'empty'}</span>
            ) : (
              l.words.slice(0, show).map((w, k) => (
                <span key={k} className="fork-word">
                  {w}
                </span>
              ))
            )}
            {l.words.length > show && <span className="fork-word muted">…</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

function TokTip({ x, y, branches, text }: { x: number; y: number; branches: number; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { style } = useNearCursor(ref, x, y, TOOLTIP_GAP);
  return (
    <div className="tok-tip" style={style} ref={ref} role="tooltip">
      {text}
      {branches > 0 && (
        <span className="tok-tip-sub">
          {branches} branch{branches > 1 ? 'es' : ''} already split here
        </span>
      )}
    </div>
  );
}

/** The menu a clicked word or gap opens: view the forks that already split there, or make a new one. */
function ForkMenu({
  x,
  y,
  forks,
  onClose,
  onFork,
  onPick,
  onOpen,
}: {
  x: number;
  y: number;
  forks: Branch[];
  /** open the node this point belongs to in a new tab or window */
  onOpen: (where: 'tab' | 'window') => void;
  onClose: () => void;
  onFork: (kind: 'generate' | 'write', count: number) => void;
  onPick: (nodeId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<'view' | 'new' | null>(null);
  const viewRow = useRef<HTMLDivElement>(null);
  const newRow = useRef<HTMLDivElement>(null);
  const nodes = useLoom((s) => s.nodes);
  const mobile = useIsMobile();
  const windowsFull = useLoom((s) => s.windows.length >= MAX_WINDOWS);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  const place = useNearCursor(ref, x, y);
  const label = ({ id, from }: Branch) => {
    const n = nodes[id];
    const ms = n?.messages ?? [];
    // a node's own text after the point: only what comes after it
    const texts = from ? [ms[from.msg]?.text.slice(from.offset) ?? '', ...ms.slice(from.msg + 1).map((m) => m.text)] : ms.map((m) => m.text);
    const t = texts.join(' ').trim().split(/\s+/).slice(0, 6).join(' ');
    if (t) return `${t}…`;
    return ms.some((m) => m.generating) ? '(the model is writing it)' : '(empty: you write it)';
  };
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const list = forks.map((b) => (
    <button key={`${b.id}${b.from ? ':rest' : ''}`} role="menuitem" className="fork-pick" onClick={act(() => onPick(b.id))}>
      {label(b)}
    </button>
  ));
  return (
    <div className={`node-menu${place.subClass}`} style={place.style} ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="has-sub" ref={viewRow} onPointerEnter={(e) => e.pointerType === 'mouse' && forks.length && setSub('view')} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(null)}>
        <button role="menuitem" disabled={!forks.length} aria-haspopup="menu" onClick={() => forks.length && setSub('view')}>
          view forks here <span className="chev">›</span>
        </button>
        {sub === 'view' && forks.length > 0 && <Flyout anchor={viewRow}>{list}</Flyout>}
      </div>
      {/* the same choices as "fork from here" on a canvas node, made at this point */}
      <div className="has-sub" ref={newRow} onPointerEnter={(e) => e.pointerType === 'mouse' && setSub('new')} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(null)}>
        <button role="menuitem" aria-haspopup="menu" onClick={() => setSub('new')}>
          new fork here <span className="chev">›</span>
        </button>
        {sub === 'new' && (
          <Flyout anchor={newRow}>
            <button role="menuitem" onClick={act(() => onFork('generate', 1))}>
              generate 1 branch
            </button>
            <button role="menuitem" onClick={act(() => onFork('generate', 3))}>
              generate 3 branches
            </button>
            <button role="menuitem" onClick={act(() => onFork('write', 1))}>
              write the next message
            </button>
          </Flyout>
        )}
      </div>
      <button role="menuitem" onClick={act(() => onOpen('tab'))}>
        open in new tab
      </button>
      {!mobile && (
        <button
          role="menuitem"
          disabled={windowsFull}
          title={windowsFull ? `${MAX_WINDOWS} windows are already open` : undefined}
          onClick={act(() => onOpen('window'))}
        >
          open in new window
        </button>
      )}
    </div>
  );
}

function Messages({ tab }: { tab: Tab }) {
  const { bubbles, forks, forkKids } = useConversation(tab.headId);
  // only the branches that carry on from the very end of the conversation get the tree
  const endKids = useLoom((s) => {
    const head = s.nodes[tab.headId];
    if (!head || head.messages.some((m) => m.generating)) return NO_KIDS;
    const kids = (s.children[head.id] ?? []).filter((c) => {
      const f = s.nodes[c]?.forkAt;
      const last = head.messages.length - 1;
      return !!f && (head.messages.length === 0 || (f.msg === last && f.offset >= head.messages[last].text.length));
    });
    return kids.length ? kids.join(',') : NO_KIDS;
  }).split(',').filter(Boolean);
  // the model writes one message at a time: the others wait their turn
  const writing = useLoom((s) => s.streamOrder[0]);
  // only the in-page model queues; other backends write side by side
  const queued = useLoom((s) => s.streamOrder);
  const busy = useLoom((s) => !!s.nodes[tab.headId]?.messages.some((m) => m.generating));
  const auto = useChatPrefs((s) => s.autoPrompt);
  const menuOpenedAt = useRef(0);
  const [menu, setMenu] = useState<(TreePoint & { x: number; y: number; top: boolean }) | null>(null);
  const forkAtPoint = useLoom((s) => s.forkAtPoint);
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; branches: number; text: string } | null>(null);
  const stick = useRef(true);
  /** where the chat last scrolled itself to: a scroll to there is not you looking around */
  const autoTop = useRef(-1);
  const tipTimer = useRef<number>();
  const tipFor = useRef<HTMLElement | null>(null);
  const cursor = useRef({ x: 0, y: 0 });
  const hideTip = () => {
    tipFor.current = null;
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };
  const toEnd = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    autoTop.current = el.scrollTop;
  };
  const textLen = bubbles.reduce((a, b) => a + b.pieces.reduce((x, p) => x + p.text.length, 0), 0);

  useLayoutEffect(() => {
    if (stick.current) toEnd();
  }, [textLen, bubbles.length]);

  useEffect(() => {
    stick.current = true;
    toEnd();
  }, [tab.headId]);

  // what can be clicked: any word, and the gaps between bubbles
  const target = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('.gap, .tok');
  const tipTarget = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-tip], .tok');
  const open = (e: React.MouseEvent, t: HTMLElement) => {
    hideTip();
    menuOpenedAt.current = performance.now();
    setMenu({ x: e.clientX, y: e.clientY, nodeId: t.dataset.n!, msg: Number(t.dataset.m), offset: Number(t.dataset.o), top: !!t.dataset.top });
  };
  const lastRole = bubbles[bubbles.length - 1]?.role;

  return (
    <div
      className="msgs"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        // the chat following the text as it is written: menus and tips stay open
        if (Math.abs(el.scrollTop - autoTop.current) < 2) return;
        hideTip();
        // only a scroll you make closes the menu, not one caused by the click that opened it
        if (performance.now() - menuOpenedAt.current > 300) setMenu(null);
      }}
      onMouseMove={(e) => {
        cursor.current = { x: e.clientX, y: e.clientY };
        // which side of the chat the mouse is over: the robot buttons of that side show. The voice
        // that spoke last has the wider side (70%): carrying its message on is the nearer thing to do
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        const split = lastRole === 'model' ? 0.7 : lastRole === 'user' ? 0.3 : 0.5;
        const side = e.clientX < r.left + r.width * split ? 'left' : 'right';
        if (el.dataset.side !== side) el.dataset.side = side;
      }}
      onMouseOver={(e) => {
        cursor.current = { x: e.clientX, y: e.clientY };
        const t = tipTarget(e);
        if (!t) {
          tipFor.current = null;
          window.clearTimeout(tipTimer.current);
          return setTip(null);
        }
        if (tipFor.current === t) return;
        tipFor.current = t;
        window.clearTimeout(tipTimer.current);
        setTip(null);
        tipTimer.current = window.setTimeout(() => {
          setTip({ ...cursor.current, branches: Number(t.dataset.b ?? 0), text: t.dataset.tip ?? 'click to fork at this word' });
        }, TOOLTIP_DELAY_MS);
      }}
      onMouseLeave={(e) => {
        hideTip();
        delete e.currentTarget.dataset.side;
      }}
      onContextMenu={(e) => {
        const t = target(e);
        if (!t) return;
        e.preventDefault();
        open(e, t);
      }}
      onClick={(e) => {
        const t = target(e);
        if (t) open(e, t);
      }}
    >
      {bubbles.length === 0 && <p className="msgs-empty">Nothing here yet. Write the first message below.</p>}
      {bubbles.map((b, i) => {
        const first = b.pieces[0];
        const last = b.pieces[b.pieces.length - 1];
        const end = i === bubbles.length - 1;
        const live = b.pieces.find((p) => p.generating);
        const tree = end && endKids.length > 0;
        return (
          <Fragment key={`${first.nodeId}:${first.msg}`}>
            {i === 0 && <Gap at={{ nodeId: first.nodeId, msg: first.msg, offset: 0 }} top branches={forks.get(markKey(first.nodeId, first.msg, 0, true)) ?? 0} />}
            <BubbleView
              bubble={b}
              forks={forks}
              waiting={!!live && queued.includes(`${live.nodeId}:${live.msg}`) && `${live.nodeId}:${live.msg}` !== writing}
              tail={end && !auto ? <RobotButton tabId={tab.id} voice={b.role} off={busy} /> : undefined}
            />
            {tree && <ForkTree kids={endKids} onPick={(id) => useLoom.getState().goToNode(tab.id, id)} />}
            {!last.generating && (
              <Gap at={{ nodeId: last.nodeId, msg: last.msg, offset: last.text.length }} branches={forks.get(markKey(last.nodeId, last.msg, last.text.length)) ?? 0} quiet={tree} />
            )}
          </Fragment>
        );
      })}
      {/* where the next message would be: the robot writes it, in the voice that did not speak last (either, in an empty chat) */}
      {!auto && (
        <div className="ghost-row">
          {lastRole !== 'model' && <RobotButton tabId={tab.id} voice="model" off={busy} />}
          {lastRole !== 'user' && <RobotButton tabId={tab.id} voice="user" off={busy} />}
        </div>
      )}
      {menu && (
        <ForkMenu
          x={menu.x}
          y={menu.y}
          forks={forkKids.get(markKey(menu.nodeId, menu.msg, menu.offset, menu.top)) ?? []}
          onClose={() => setMenu(null)}
          onFork={(kind, count) => forkAtPoint(tab.id, menu.nodeId, menu.msg, menu.offset, kind, count)}
          onPick={(id) => useLoom.getState().goToNode(tab.id, id)}
          onOpen={(where) => useLoom.getState().openNodeIn(menu.nodeId, where)}
        />
      )}
      {tip && !menu && <TokTip {...tip} />}
    </div>
  );
}

const TYPE_AS: TypeAs[] = ['user', 'assistant', 'alternate'];

/**
 * The ⋮ menu beside the chat box: whether the model answers by itself when you send a message,
 * and whose voice your messages go in.
 */
function ChatMenu({ at, anchor, onClose }: { at: { right: number; bottom: number }; anchor: RefObject<HTMLElement>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState(false);
  const auto = useChatPrefs((s) => s.autoPrompt);
  const typeAs = useChatPrefs((s) => s.typeAs);
  const setPrefs = useChatPrefs((s) => s.set);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as globalThis.Node;
      // (the ⋮ button closes it itself)
      if (ref.current && !ref.current.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose, anchor]);
  return (
    <div className="node-menu chat-menu" style={at} ref={ref} role="menu">
      <div className="chat-menu-row">
        <span id="auto-prompt-label">auto-prompt model when you send a message</span>
        <button type="button" role="switch" className="switch" aria-checked={auto} aria-labelledby="auto-prompt-label" onClick={() => setPrefs({ autoPrompt: !auto })}>
          <span className="knob" />
        </button>
      </div>
      <div className="has-sub" ref={row} onPointerEnter={(e) => e.pointerType === 'mouse' && setSub(true)} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(false)}>
        <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setSub(true)}>
          <span>your messages show up as the:</span>
          <span className="chat-menu-val">
            {typeAs} <span className="chev">›</span>
          </span>
        </button>
        {sub && (
          <Flyout anchor={row}>
            {TYPE_AS.map((t) => (
              <button
                key={t}
                type="button"
                role="menuitemradio"
                aria-checked={t === typeAs}
                onClick={() => {
                  setPrefs({ typeAs: t });
                  setSub(false);
                }}
              >
                {t}
                {t === typeAs && <span className="tick">✓</span>}
              </button>
            ))}
          </Flyout>
        )}
      </div>
    </div>
  );
}

function Composer({ tab }: { tab: Tab }) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<{ right: number; bottom: number } | null>(null);
  const auto = useChatPrefs((s) => s.autoPrompt);
  const typeAs = useChatPrefs((s) => s.typeAs);
  const last = useLoom((s) => lastVoice(s.nodes, tab.headId));
  // the model is writing in this chat (or waiting to): the send button stops it
  const busy = useLoom((s) => !!s.nodes[tab.headId]?.messages.some((m) => m.generating));
  const send = useLoom((s) => s.sendMessage);
  const focusRequest = useLoom((s) => s.focusRequest);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dots = useRef<HTMLButtonElement>(null);
  // whose voice the next message goes in. The same voice as the last words: it joins that message
  const role = voiceFor(typeAs, last);
  const name = role === 'model' ? 'assistant' : 'user';

  useEffect(() => {
    if (focusRequest?.tabId === tab.id) ref.current?.focus();
  }, [focusRequest, tab.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const submit = () => {
    if (busy || !text.trim()) return;
    send(tab.id, text, role, auto);
    setText('');
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {last === role && !busy && <p className="composer-hint">this adds to the {name} message above</p>}
      <div className="composer-row">
        <div className="composer-box">
          <textarea
            id={`composer-${tab.id}`}
            ref={ref}
            rows={1}
            value={text}
            placeholder={`send a new ${name} message`}
            aria-label="Message this thread"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button key="stop" type="button" className="send stop" aria-label="Stop the model" title="Stop the model" onClick={() => useLoom.getState().stopGenerating(tab.id)}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button key="send" type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          ref={dots}
          className="composer-dots"
          title="Chat options"
          aria-label="Chat options"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // its right edge on the button's, moved right when a narrow chat would push its left side off the window
            const right = Math.min(window.innerWidth - r.right, window.innerWidth - CHAT_MENU_W - 8);
            setMenu(menu ? null : { right: Math.max(8, right), bottom: window.innerHeight - r.top + 6 });
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="3" r="1.5" fill="currentColor" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <circle cx="8" cy="13" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </div>
      {menu && <ChatMenu at={menu} anchor={dots} onClose={() => setMenu(null)} />}
    </form>
  );
}

/** The tab's label: a typed name, else the head node's first diverging token. */
function useTabLabel(tab: Tab) {
  const auto = useLoom((s) => divergingToken(s.nodes, tab.headId));
  return tab.name || auto;
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** A window with an × in it: closes the whole window (all its tabs). */
const CloseWindowIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const DRAG_START_PX = 5;

/**
 * Where a tab dragged to (x, y) would land: a position in a window's tab row, the end of a
 * window's tabs (dropped on its chat), or a new window (dropped anywhere else).
 */
function dropTarget(tabId: string, x: number, y: number): NonNullable<ReturnType<typeof useUi.getState>['tabDrag']>['target'] {
  const s = useLoom.getState();
  const from = s.windows.find((w) => w.tabIds.includes(tabId));
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const strip = el?.closest<HTMLElement>('[data-strip]');
  if (strip) {
    const others = [...strip.querySelectorAll<HTMLElement>('[data-tab]')].filter((t) => t.dataset.tab !== tabId);
    const index = others.filter((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 < x;
    }).length;
    return { windowId: strip.dataset.strip!, index };
  }
  const win = el?.closest<HTMLElement>('[data-window]');
  if (win) {
    if (win.dataset.window === from?.id) return null; // back where it started
    const w = s.windows.find((x) => x.id === win.dataset.window);
    return w ? { windowId: w.id, index: w.tabIds.length } : null;
  }
  if (!from || from.tabIds.length < 2) return null; // already a window of its own
  return s.windows.length >= MAX_WINDOWS ? 'blocked' : 'new';
}

/**
 * One tab head: the name, outlined in the thread's colour when it is the tab showing in its window.
 * Click to show it, click the showing tab's name to rename it, drag it to reorder or move it to
 * another window (or out, to a new window), right-click for the tab menu, middle-click to close.
 */
function FolderTab({
  tab,
  active,
  index,
  draggable,
  onMenu,
}: {
  tab: Tab;
  active: boolean;
  index: number;
  draggable: boolean;
  onMenu: (tabId: string, x: number, y: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const linkHover = useLinkHover(tab.headId);
  const L = useLoom.getState();
  const label = useTabLabel(tab);
  const c = colorOf(tab.color);
  const dragging = useUi((s) => s.tabDrag?.tabId === tab.id);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing || !draggable || e.pointerType !== 'mouse') return;
    if ((e.target as HTMLElement).closest('button')) return;
    // the pointer is only captured once a drag starts, so a plain click still reaches the name (rename)
    press.current = { x: e.clientX, y: e.clientY, dragging: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START_PX) return;
    if (!p.dragging) e.currentTarget.setPointerCapture(e.pointerId);
    p.dragging = true;
    useUi.getState().set({ tabDrag: { tabId: tab.id, x: e.clientX, y: e.clientY, target: dropTarget(tab.id, e.clientX, e.clientY) } });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!p?.dragging) return;
    const target = useUi.getState().tabDrag?.target ?? null;
    useUi.getState().set({ tabDrag: null });
    if (target === 'new') L.moveTab(tab.id, 'new');
    else if (target === 'blocked') L.showToast(`You can have ${MAX_WINDOWS} windows open at once.`);
    else if (target) L.moveTab(tab.id, target);
    // swallow the click that follows a drag
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  };

  return (
    <div
      className={`folder-tab${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
      style={{ '--c': c.core, '--f': c.fringe } as CSSProperties}
      data-tab={tab.id}
      data-index={index}
      role="tab"
      aria-selected={active}
      onClick={() => !active && L.setActiveTab(tab.id)}
      // hovering a tab outlines its node on the canvas, like hovering the node itself
      {...linkHover}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          L.closeTab(tab.id);
        }
      }}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(tab.id, e.clientX, e.clientY);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null;
        useUi.getState().set({ tabDrag: null });
      }}
    >
      {editing ? (
        <input
          className="tab-name-input"
          defaultValue={label}
          autoFocus
          aria-label="Thread name"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            L.renameTab(tab.id, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          className="tab-name"
          title={active ? 'click to rename, drag to move' : tab.name || 'first diverging token of this branch'}
          onClick={(e) => {
            if (!active) return; // the tab's own click shows it
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {label}
        </span>
      )}
      {(
        <button
          className="icon-btn tab-close"
          title="Close tab"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            L.closeTab(tab.id);
          }}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/** Right-click menu on a tab: the usual browser tab actions. */
function TabMenu({ tabId, x, y, onClose }: { tabId: string; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useNearCursor(ref, x, y);
  const L = useLoom.getState();
  const win = useLoom((s) => s.windows.find((w) => w.tabIds.includes(tabId)));
  const windowsFull = useLoom((s) => s.windows.length >= MAX_WINDOWS);
  const mobile = useIsMobile();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  if (!win) return null;
  const i = win.tabIds.indexOf(tabId);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div className="node-menu" style={place.style} ref={ref} role="menu">
      {!mobile && (
        <button
          role="menuitem"
          disabled={win.tabIds.length < 2 || windowsFull}
          title={windowsFull ? `${MAX_WINDOWS} windows are already open` : win.tabIds.length < 2 ? 'this tab is already its own window' : undefined}
          onClick={act(() => L.moveTab(tabId, 'new'))}
        >
          move tab to new window
        </button>
      )}
      <button role="menuitem" onClick={act(() => L.closeTab(tabId))}>
        close tab
      </button>
      <button role="menuitem" disabled={i === win.tabIds.length - 1} onClick={act(() => L.closeTabsToRight(tabId))}>
        close tabs to the right
      </button>
      {!mobile && (
        <button role="menuitem" className="danger" onClick={act(() => L.closeWindow(win.id))}>
          close window
        </button>
      )}
    </div>
  );
}

/** Three stacked cards: the "all tabs" group. */
const StackIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform="skewY(-8) translate(0 3)">
      <path d="M3 17V8.5A3 3 0 0 1 6 5.5h9" />
      <path d="M6.5 19.5v-8a3 3 0 0 1 3-3h9" />
      <rect x="10" y="11.5" width="12" height="10" rx="2.5" />
    </g>
  </svg>
);

/** Narrowest a tab may get before the row switches to "current tab + stack". */
const TAB_MIN_W = 76;
const TAB_GAP = 3;

/** Every tab of a window in a scrollable list: pick one to bring it to the front, × to close it. */
function TabListMenu({ tabs, activeId, x, y, onClose }: { tabs: Tab[]; activeId: string; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useNearCursor(ref, x, y);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return (
    <div className="node-menu tab-list" style={place.style} ref={ref} role="menu" aria-label="Other tabs in this window">
      {tabs.map((t) => (
        <TabListRow key={t.id} tab={t} current={t.id === activeId} onPicked={onClose} />
      ))}
    </div>
  );
}
function TabListRow({ tab, current, onPicked }: { tab: Tab; current: boolean; onPicked: () => void }) {
  const label = useTabLabel(tab);
  const linkHover = useLinkHover(tab.headId);
  const L = useLoom.getState();
  return (
    <div
      className={`tab-list-row${current ? ' current' : ''}`}
      {...linkHover}
    >
      <button
        role="menuitem"
        className="tab-list-name"
        onClick={() => {
          L.setActiveTab(tab.id);
          onPicked();
        }}
      >
        <span className="tab-name">{label}</span>
      </button>
      <button className="icon-btn tab-close" title="Close tab" aria-label={`Close ${label}`} onClick={() => L.closeTab(tab.id)}>
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * A row of tabs. All tabs share one width, shrinking as more open. When they no longer fit, the
 * row shows the current tab on the left and a stack tab on the right that lists them all.
 */
function TabRow({
  tabs,
  activeId,
  stripId,
  draggable,
  onMenu,
}: {
  tabs: Tab[];
  activeId: string;
  /** the window id, for dragging tabs in (desktop) */
  stripId?: string;
  draggable: boolean;
  onMenu: (tabId: string, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [list, setList] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const tipTimer = useRef<number>();
  const drag = useUi((s) => s.tabDrag);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const stacked = width > 0 && tabs.length > 1 && tabs.length * (TAB_MIN_W + TAB_GAP) > width;
  // once the stack is gone (its tabs closed, or they fit again) its menu closes too
  useEffect(() => {
    if (!stacked) setList(null);
  }, [stacked]);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const shown = stacked ? (active ? [active] : []) : tabs;
  const marker = drag && stripId && drag.target && typeof drag.target === 'object' && drag.target.windowId === stripId ? drag.target.index : -1;
  let k = 0;
  const items: React.ReactNode[] = [];
  shown.forEach((t) => {
    if (t.id !== drag?.tabId) {
      if (k === marker) items.push(<span key="drop" className="tab-drop" aria-hidden="true" />);
      k++;
    }
    items.push(<FolderTab key={t.id} tab={t} active={t.id === activeId} index={tabs.indexOf(t)} draggable={draggable} onMenu={onMenu} />);
  });
  if (marker >= k && marker >= 0) items.push(<span key="drop" className="tab-drop" aria-hidden="true" />);
  return (
    <div
      className={`tab-strip${stacked ? ' stacked' : ''}`}
      ref={ref}
      data-strip={stripId}
      role="tablist"
      style={{ '--tab-count': shown.length } as CSSProperties}
    >
      {items}
      {stacked && (
        <button
          type="button"
          className={`tab-stack${list ? ' open' : ''}`}
          aria-label={`See ${tabs.length - 1} more tabs`}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            window.clearTimeout(tipTimer.current);
            setTip(null);
            setList(list ? null : { x: r.left, y: r.bottom - 2 });
          }}
          onMouseEnter={(e) => {
            const at = { x: e.clientX, y: e.clientY };
            window.clearTimeout(tipTimer.current);
            tipTimer.current = window.setTimeout(() => setTip(at), TOOLTIP_DELAY_MS);
          }}
          onMouseLeave={() => {
            window.clearTimeout(tipTimer.current);
            setTip(null);
          }}
        >
          <StackIcon />
          <span className="tab-stack-count">{tabs.length - 1}</span>
        </button>
      )}
      {tip && !list && <TokTip x={tip.x} y={tip.y} branches={0} text="see all tabs" />}
      {list && <TabListMenu tabs={tabs.filter((t) => t.id !== activeId)} activeId={activeId} {...list} onClose={() => setList(null)} />}
    </div>
  );
}

/** A window's tab row and its close-window button. */
function TabStrip({ win, tabs, onMenu }: { win: Win; tabs: Tab[]; onMenu: (tabId: string, x: number, y: number) => void }) {
  return (
    <div className="col-head">
      <TabRow tabs={tabs} activeId={win.activeTabId} stripId={win.id} draggable onMenu={onMenu} />
      <div className="col-head-actions">
        <button className="icon-btn win-close" title="Close window" aria-label="Close window" onClick={() => useLoom.getState().closeWindow(win.id)}>
          <CloseWindowIcon />
        </button>
      </div>
    </div>
  );
}

function Resizer({ win, style }: { win: Win; style?: CSSProperties }) {
  const resize = useLoom((s) => s.resizeWindow);
  return (
    <div
      className="col-resizer"
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize this window"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = win.width;
        el.dataset.dragging = '1';
        const move = (ev: PointerEvent) => resize(win.id, Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX)));
        const up = () => {
          delete el.dataset.dragging;
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

/** One chat window: its tab row, the showing tab's messages and chat box. */
function WindowColumn({ win, active, last, onMenu }: { win: Win; active: boolean; last: boolean; onMenu: (tabId: string, x: number, y: number) => void }) {
  const allTabs = useLoom((s) => s.tabs);
  const tabs = win.tabIds.map((id) => allTabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  const tab = tabs.find((t) => t.id === win.activeTabId) ?? tabs[0];
  const dropHere = useUi((s) => {
    const t = s.tabDrag?.target;
    return !!t && typeof t === 'object' && t.windowId === win.id;
  });
  if (!tab) return null;
  const c = colorOf(tab.color);
  const style = { width: win.width, '--c': c.core, '--f': c.fringe, '--c-dark': c.dark, '--c-idle': c.idle } as CSSProperties;
  return (
    <section
      className={`col${active ? ' active' : ''}${dropHere ? ' drop-target' : ''}`}
      style={style}
      data-window={win.id}
      aria-label="Chat window"
      onPointerDownCapture={() => useLoom.getState().setActiveTab(tab.id)}
    >
      <TabStrip win={win} tabs={tabs} onMenu={onMenu} />
      <Messages key={tab.id} tab={tab} />
      <Composer key={`c-${tab.id}`} tab={tab} />
      {/* the last window's handle lives outside the scrolling sidebar so it can straddle the edge */}
      {!last && <Resizer win={win} />}
    </section>
  );
}

/** The tab following the cursor while it's dragged, saying where it will land. */
function TabDragGhost() {
  const drag = useUi((s) => s.tabDrag);
  const tab = useLoom((s) => (drag ? s.tabs.find((t) => t.id === drag.tabId) : undefined));
  if (!drag || !tab) return null;
  const hint = drag.target === 'new' ? 'new window' : drag.target === 'blocked' ? `${MAX_WINDOWS} windows max` : null;
  return (
    <div className="tab-ghost" style={{ left: drag.x + 10, top: drag.y + 12 }} aria-hidden="true">
      <GhostLabel tab={tab} />
      {hint && <span className={`tab-ghost-hint${drag.target === 'blocked' ? ' blocked' : ''}`}>{hint}</span>}
    </div>
  );
}
function GhostLabel({ tab }: { tab: Tab }) {
  return <span className="tab-ghost-label">{useTabLabel(tab)}</span>;
}

function RailPip({ tab, showing }: { tab: Tab; showing: boolean }) {
  const c = colorOf(tab.color);
  const label = useTabLabel(tab);
  return (
    <button
      className={`rail-pip glow${showing ? '' : ' background'}`}
      style={{ '--c': c.core, '--f': c.fringe } as CSSProperties}
      title={label}
      aria-label={`Open ${label}`}
      onClick={() => {
        const L = useLoom.getState();
        L.setActiveTab(tab.id);
        L.toggleSidebar();
      }}
    >
      {label}
    </button>
  );
}

/** Phone layout: the chat view. One chat at a time; every open tab sits in one row across the top. */
export function MobileChat() {
  const tabs = useLoom((s) => s.tabs);
  const windows = useLoom((s) => s.windows);
  const activeTabId = useLoom((s) => s.activeTabId);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const ordered = windows.flatMap((w) => w.tabIds).map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  const tab = ordered.find((t) => t.id === activeTabId) ?? ordered[0];
  if (!tab) {
    return (
      <div className="m-chat m-empty">
        <p>No chats open. Double tap a node in the tree to open it here.</p>
      </div>
    );
  }
  const c = colorOf(tab.color);
  return (
    <section className="m-chat col active" style={{ '--c': c.core, '--f': c.fringe, '--c-dark': c.dark } as CSSProperties}>
      <div className="col-head m-head">
        <div className="m-head-actions">
          <SidebarToggle />
        </div>
        <nav className="m-tabrow" aria-label="Open chats">
          <TabRow tabs={ordered} activeId={tab.id} draggable={false} onMenu={(tabId, x, y) => setMenu({ tabId, x, y })} />
        </nav>
      </div>
      <Messages key={tab.id} tab={tab} />
      <Composer key={`c-${tab.id}`} tab={tab} />
      {menu && <TabMenu {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

export function Sidebar() {
  const tabs = useLoom((s) => s.tabs);
  const windows = useLoom((s) => s.windows);
  const activeWindowId = useLoom((s) => s.activeWindowId);
  const folded = useLoom((s) => s.sidebarFolded);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const onMenu = (tabId: string, x: number, y: number) => setMenu({ tabId, x, y });
  const lastWin = windows[windows.length - 1];
  const lastColor = tabs.find((t) => t.id === lastWin?.activeTabId)?.color ?? 0;

  // no chats open: no sidebar at all, the canvas takes the space
  if (!tabs.length) return <TabDragGhost />;

  if (folded) {
    return (
      <aside className="rail" aria-label="Chats (collapsed)">
        {windows.map((w, i) => (
          <div key={w.id} className="rail-window">
            {i > 0 && <span className="rail-sep" aria-hidden="true" />}
            {w.tabIds.map((id) => {
              const t = tabs.find((x) => x.id === id);
              return t ? <RailPip key={id} tab={t} showing={id === w.activeTabId} /> : null;
            })}
          </div>
        ))}
      </aside>
    );
  }

  return (
    <div className="sidebar-wrap">
      <aside className="sidebar" aria-label="Chat windows">
        {windows.map((w, i) => (
          <WindowColumn key={w.id} win={w} active={w.id === activeWindowId} last={i === windows.length - 1} onMenu={onMenu} />
        ))}
        {menu && <TabMenu {...menu} onClose={() => setMenu(null)} />}
        <TabDragGhost />
      </aside>
      {lastWin && <Resizer win={lastWin} style={{ '--c': colorOf(lastColor).core } as CSSProperties} />}
    </div>
  );
}
