import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MAX_WINDOWS, colorOf, divergingToken, pathTo, piecesFor, useLoom, useUi, type Piece, type Role, type Tab, type Win } from '../store';
import { useIsMobile } from '../useIsMobile';
import { tokenize } from '../text';
import { SidebarToggle } from '../Chrome';
import { TOOLTIP_DELAY_MS, TOOLTIP_GAP, useNearCursor } from '../floating';
import { Flyout } from '../Flyout';

const MIN_W = 240;
const MAX_W = 720;

interface Bubble {
  role: Role;
  pieces: Piece[];
}

/** branch counts by `${nodeId}:${msg}:${offset}` for every node on the path */
type ForkCounts = Map<string, number>;

/**
 * The conversation as bubbles. One bubble is one message. A piece joins the previous bubble when it
 * carries on the same message: the previous piece was cut off part-way (a fork), or this piece is
 * the first message of a child node in the same voice (a node split mid-message, or a branch that
 * continues the text). Two whole messages of one node are never merged.
 */
function useConversation(headId: string) {
  const nodes = useLoom((s) => s.nodes);
  const children = useLoom((s) => s.children);
  return useMemo(() => {
    const bubbles: Bubble[] = [];
    for (const p of piecesFor(nodes, headId)) {
      const last = bubbles[bubbles.length - 1];
      const prev = last?.pieces[last.pieces.length - 1];
      const continues = !!prev && (!prev.whole || (p.nodeId !== prev.nodeId && p.msg === 0));
      if (last && last.role === p.role && continues) last.pieces.push(p);
      else bubbles.push({ role: p.role, pieces: [p] });
    }
    const forks: ForkCounts = new Map();
    const forkKids = new Map<string, string[]>();
    for (const n of pathTo(nodes, headId)) {
      for (const c of children[n.id] ?? []) {
        const f = nodes[c]?.forkAt;
        if (!f) continue;
        const key = `${n.id}:${f.msg}:${f.offset}`;
        forks.set(key, (forks.get(key) ?? 0) + 1);
        forkKids.set(key, [...(forkKids.get(key) ?? []), c]);
      }
    }
    // a node on the path whose parent forks at the same point has alternatives at its first token
    for (const n of pathTo(nodes, headId)) {
      if (!n.parentId || n.isRoot) continue;
      const sibs = (children[n.parentId] ?? []).filter((c) => {
        const a = nodes[c]?.forkAt;
        const b = n.forkAt;
        return c !== n.id && (a === b || (!!a && !!b && a.msg === b.msg && a.offset === b.offset));
      });
      if (!sibs.length) continue;
      const key = `${n.id}:0:0`;
      forks.set(key, (forks.get(key) ?? 0) + sibs.length);
      forkKids.set(key, [...(forkKids.get(key) ?? []), ...sibs]);
    }
    const onPath = new Set(pathTo(nodes, headId).map((n) => n.id));
    // the last message carries on into branches in the same voice: it hasn't ended
    const head = nodes[headId];
    const lastMsg = head?.messages[head.messages.length - 1];
    const endContinues =
      !!head &&
      !!lastMsg &&
      (children[head.id] ?? []).some((c) => {
        const f = nodes[c]?.forkAt;
        return !!f && f.msg === head.messages.length - 1 && f.offset >= lastMsg.text.length && nodes[c].messages[0]?.role === lastMsg.role;
      });
    return { bubbles, forks, forkKids, onPath, endContinues };
  }, [nodes, children, headId]);
}

/* The ‹u› / ‹as› tags are real points in the text: the start of a message (top) and its end (bottom). */
function ForkTag({ bubble, edge, forks }: { bubble: Bubble; edge: 'top' | 'bottom'; forks: ForkCounts }) {
  const tag = bubble.role === 'model' ? 'as' : 'u';
  const piece = edge === 'top' ? bubble.pieces[0] : bubble.pieces[bubble.pieces.length - 1];
  const offset = edge === 'top' ? 0 : piece.text.length;
  const tip = 'click for forks at this token';
  const branches = forks.get(`${piece.nodeId}:${piece.msg}:${offset}`) ?? 0;
  return (
    <button
      type="button"
      className={`tag ${edge}${branches ? ' loomed' : ''}`}
      data-n={piece.nodeId}
      data-m={piece.msg}
      data-o={offset}
      data-tip={tip}
      data-b={branches || undefined}
      aria-label={tip}
    >
      ‹{tag}›
    </button>
  );
}

/** The message has really ended: its last piece is the whole message, has text (an empty one is an
 *  open token, still to be written) and nothing is still being written. */
const bubbleEnded = (b: Bubble) => {
  const last = b.pieces[b.pieces.length - 1];
  return last.whole && !last.generating && last.text.length > 0;
};

const BubbleView = memo(function BubbleView({ bubble, forks, continues }: { bubble: Bubble; forks: ForkCounts; continues?: boolean }) {
  const generating = bubble.pieces.some((p) => p.generating);
  return (
    <div className={`bubble ${bubble.role}${bubble.pieces.every((p) => !p.text) && !generating ? ' open-token' : ''}`}>
      <ForkTag bubble={bubble} edge="top" forks={forks} />
      <p>
        {bubble.pieces.map((p) => {
          const base = `${p.nodeId}:${p.msg}:`;
          return tokenize(p.text).map((tok) => {
            if (tok.space) return tok.text;
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
        {generating && <span className="caret" aria-hidden="true" />}
      </p>
      {bubbleEnded(bubble) && !continues && <ForkTag bubble={bubble} edge="bottom" forks={forks} />}
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

function TokTip({ x, y, branches, text }: { x: number; y: number; branches: number; text?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { style } = useNearCursor(ref, x, y, TOOLTIP_GAP);
  return (
    <div className="tok-tip" style={style} ref={ref} role="tooltip">
      {text ?? 'click for forks at this token'}
      {branches > 0 && (
        <span className="tok-tip-sub">
          {branches} branch{branches > 1 ? 'es' : ''} already split here
        </span>
      )}
    </div>
  );
}

/** The menu a clicked token opens: view the forks that already split here, or make a new one. */
function TokenMenu({
  x,
  y,
  forks,
  rootLevel,
  onClose,
  onFork,
  onPick,
  onOpen,
}: {
  x: number;
  y: number;
  forks: string[];
  /** open the node this token belongs to in a new tab or window */
  onOpen: (where: 'tab' | 'window') => void;
  /** the fork would hang straight off the root, where only you can write */
  rootLevel: boolean;
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
  const label = (id: string) => {
    const t = (nodes[id]?.messages.map((m) => m.text).join(' ') ?? '').trim().split(/\s+/).slice(0, 6).join(' ');
    return t ? `${t}…` : '(empty: you write it)';
  };
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div className={`node-menu${place.subClass}`} style={place.style} ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="has-sub" ref={viewRow} onPointerEnter={(e) => e.pointerType === 'mouse' && forks.length && setSub('view')} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(null)}>
        <button role="menuitem" disabled={!forks.length} aria-haspopup="menu" onClick={() => forks.length && setSub('view')}>
          view forks at this token <span className="chev">›</span>
        </button>
        {sub === 'view' && forks.length > 0 && (
          <Flyout anchor={viewRow}>
            {forks.map((id) => (
              <button key={id} role="menuitem" onClick={act(() => onPick(id))}>
                {label(id)}
              </button>
            ))}
          </Flyout>
        )}
      </div>
      {/* the same choices as "fork from here" on a canvas node, made at this token */}
      <div className="has-sub" ref={newRow} onPointerEnter={(e) => e.pointerType === 'mouse' && setSub('new')} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(null)}>
        <button role="menuitem" aria-haspopup="menu" onClick={() => setSub('new')}>
          new fork at this token <span className="chev">›</span>
        </button>
        {sub === 'new' && (
          <Flyout anchor={newRow}>
            <button role="menuitem" disabled={rootLevel} onClick={act(() => onFork('generate', 1))}>
              generate 1 branch
            </button>
            <button role="menuitem" disabled={rootLevel} onClick={act(() => onFork('generate', 3))}>
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
  const { bubbles, forks, forkKids, endContinues } = useConversation(tab.headId);
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
  const menuOpenedAt = useRef(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    msg: number;
    offset: number;
  } | null>(null);
  const forkAtPoint = useLoom((s) => s.forkAtPoint);
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; branches: number; text?: string } | null>(null);
  const stick = useRef(true);
  const tipTimer = useRef<number>();
  const tipFor = useRef<HTMLElement | null>(null);
  const cursor = useRef({ x: 0, y: 0 });
  const hideTip = () => {
    tipFor.current = null;
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };
  const textLen = bubbles.reduce((a, b) => a + b.pieces.reduce((x, p) => x + p.text.length, 0), 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [textLen, bubbles.length]);

  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab.headId]);

  const target = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('.tok, .tag');

  return (
    <div
      className="msgs"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        hideTip();
        // only a scroll you make closes the menu, not one caused by the click that opened it
        if (performance.now() - menuOpenedAt.current > 300) setMenu(null);
      }}
      onMouseMove={(e) => {
        cursor.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseOver={(e) => {
        cursor.current = { x: e.clientX, y: e.clientY };
        const t = target(e);
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
          setTip({ ...cursor.current, branches: Number(t.dataset.b ?? 0), text: t.dataset.tip });
        }, TOOLTIP_DELAY_MS);
      }}
      onMouseLeave={hideTip}
      onContextMenu={(e) => {
        e.preventDefault();
        const t = target(e);
        if (!t) return;
        hideTip();
        menuOpenedAt.current = performance.now();
        setMenu({ x: e.clientX, y: e.clientY, nodeId: t.dataset.n!, msg: Number(t.dataset.m), offset: Number(t.dataset.o) });
      }}
      onClick={(e) => {
        const t = target(e);
        if (!t) return;
        hideTip();
        // text tokens and the ‹u›/‹as› tags are the same thing: a point in the text. Both open the menu.
        menuOpenedAt.current = performance.now();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          nodeId: t.dataset.n!,
          msg: Number(t.dataset.m),
          offset: Number(t.dataset.o),
        });
      }}
    >
      {bubbles.length === 0 && (
        <p className="msgs-empty">
          Nothing here yet. Write the first message below.
        </p>
      )}
      {bubbles.map((b, i) => (
        <BubbleView key={`${b.pieces[0].nodeId}:${b.pieces[0].msg}`} bubble={b} forks={forks} continues={i === bubbles.length - 1 && endContinues} />
      ))}
      {endKids.length > 0 && <ForkTree kids={endKids} onPick={(id) => useLoom.getState().goToNode(tab.id, id)} />}
      {menu && (
        <TokenMenu
          {...menu}
          forks={forkKids.get(`${menu.nodeId}:${menu.msg}:${menu.offset}`) ?? []}
          onClose={() => setMenu(null)}
          rootLevel={(() => {
            const n = useLoom.getState().nodes[menu.nodeId];
            return !!n && menu.msg === 0 && menu.offset === 0 && !!useLoom.getState().nodes[n.parentId ?? '']?.isRoot;
          })()}
          onFork={(kind, count) => forkAtPoint(tab.id, menu.nodeId, menu.msg, menu.offset, kind, count)}
          onPick={(id) => useLoom.getState().goToNode(tab.id, id)}
          onOpen={(where) => useLoom.getState().openNodeIn(menu.nodeId, where)}
        />
      )}
      {tip && !menu && <TokTip {...tip} />}
    </div>
  );
}

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M8 2.75C8 2.47386 7.77614 2.25 7.5 2.25C7.22386 2.25 7 2.47386 7 2.75V7H2.75C2.47386 7 2.25 7.22386 2.25 7.5C2.25 7.77614 2.47386 8 2.75 8H7V12.25C7 12.5261 7.22386 12.75 7.5 12.75C7.77614 12.75 8 12.5261 8 12.25V8H12.25C12.5261 8 12.75 7.77614 12.75 7.5C12.75 7.22386 12.5261 7 12.25 7H8V2.75Z"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);

/** The + menu beside the chat box: insert a ‹u› / ‹as› token, or let the model carry on from here. */
function InsertMenu({ tab, x, y, onClose }: { tab: Tab; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useNearCursor(ref, x, y);
  const canComplete = useLoom((s) => {
    const h = s.nodes[tab.headId];
    return !!h && !h.isRoot && h.messages.length > 0 && !h.messages.some((m) => m.generating);
  });
  const busy = useLoom((s) => !!s.nodes[tab.headId]?.messages.some((m) => m.generating));
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
  const L = useLoom.getState();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div className="node-menu" style={place.style} ref={ref} role="menu">
      <button role="menuitem" disabled={busy} onClick={act(() => L.insertToken(tab.id, 'user'))}>
        insert user token ‹u›
      </button>
      <button role="menuitem" disabled={busy} onClick={act(() => L.insertToken(tab.id, 'model'))}>
        insert assistant token ‹as›
      </button>
      <button role="menuitem" disabled={!canComplete} onClick={act(() => L.completeHere(tab.id))}>
        prompt the model to complete from here
      </button>
    </div>
  );
}

function Composer({ tab }: { tab: Tab }) {
  const [text, setText] = useState('');
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  // an open token at the end of the chat: what you type goes into it, in its role
  const openRole = useLoom((s) => {
    const h = s.nodes[tab.headId];
    const last = h?.messages[h.messages.length - 1];
    return last && !last.text && !last.generating ? last.role : null;
  });
  const send = useLoom((s) => s.sendMessage);
  const focusRequest = useLoom((s) => s.focusRequest);
  const ref = useRef<HTMLTextAreaElement>(null);
  const continuing = useLoom((s) => {
    const head = s.nodes[tab.headId];
    if (!head || head.messages.length || !head.forkAt) return null;
    const ps = piecesFor(s.nodes, tab.headId);
    const last = ps[ps.length - 1];
    return last?.role === 'user' ? last.text.trim().split(/\s+/).slice(-4).join(' ') : null;
  });

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
    if (!text.trim()) return;
    send(tab.id, text);
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
      {continuing && <p className="composer-hint">continuing your message after “…{continuing}”</p>}
      {openRole && !continuing && <p className="composer-hint">writing as {openRole === 'model' ? 'the assistant ‹as›' : 'the user ‹u›'}</p>}
      <div className="composer-row">
      <button
        type="button"
        className="composer-plus"
        title="Insert a token or let the model continue"
        aria-label="Insert a token or let the model continue"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPlusMenu(plusMenu ? null : { x: r.left, y: r.top - 4 });
        }}
      >
        <PlusIcon />
      </button>
      <div className="composer-box">
        <textarea
          id={`composer-${tab.id}`}
          ref={ref}
          rows={1}
          value={text}
          placeholder={openRole === 'model' ? 'write as the assistant' : 'chat here'}
          aria-label="Message this thread"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      </div>
      {plusMenu && <InsertMenu tab={tab} {...plusMenu} onClose={() => setPlusMenu(null)} />}
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
