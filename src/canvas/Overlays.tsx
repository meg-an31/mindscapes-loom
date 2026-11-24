import { useEffect, useRef, useState } from 'react';
import { MAX_WINDOWS, exportMarkdown, hasHiddenBelow, useLoom, useUi } from '../store';
import { useIsMobile } from '../useIsMobile';
import { useNearCursor } from '../floating';
import { Flyout } from '../Flyout';

export function NodeTooltip() {
  const hover = useUi((s) => s.hover);
  if (!hover) return null;
  return <NodeTip x={hover.x} y={hover.y} />;
}

/** the node hint sits just off the cursor's tip */
const NODE_TIP_GAP = { x: 4, y: 10 };

function NodeTip({ x, y }: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { style } = useNearCursor(ref, x, y, NODE_TIP_GAP);
  return (
    <div className="node-tip" style={style} ref={ref} role="tooltip">
      double click to open, shift + drag to fork
    </div>
  );
}

export function NodeMenu() {
  const menu = useUi((s) => s.menu);
  const node = useLoom((s) => (menu ? s.nodes[menu.nodeId] : undefined));
  const canShow = useLoom((s) => (menu ? hasHiddenBelow(s.nodes, s.children, menu.nodeId) : false));
  const canMerge = useLoom((s) => (menu ? s.canMerge(menu.nodeId) : 'no node'));
  const [sub, setSub] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const forkRow = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const windowsFull = useLoom((s) => s.windows.length >= MAX_WINDOWS);
  const close = () => useUi.getState().set({ menu: null });

  useEffect(() => {
    setSub(false);
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [menu]);

  const place = useNearCursor(ref, menu?.x ?? 0, menu?.y ?? 0);
  const selection = useUi((s) => s.selection);
  if (!menu || !node) return null;
  // several nodes selected and the menu opened on one of them: act on all of them
  if (selection.length > 1 && selection.includes(node.id)) {
    const n = selection.length;
    const L2 = useLoom.getState();
    const all = (fn: () => void) => () => {
      fn();
      close();
      useUi.getState().set({ selection: [] });
    };
    return (
      <div className="node-menu" style={place.style} ref={ref} role="menu">
        <p className="menu-title">{n} nodes selected</p>
        <button role="menuitem" onClick={all(() => selection.forEach((id) => L2.openNodeIn(id, 'tab')))}>
          open each in a new tab
        </button>
        <button role="menuitem" onClick={all(() => selection.forEach((id) => L2.forkGenerate(id)))}>
          generate a branch on each
        </button>
        <button role="menuitem" onClick={all(() => L2.hideNodes(selection))}>
          hide {n} nodes (and their children)
        </button>
        <button role="menuitem" onClick={all(() => useUi.getState().set({ selection: [] }))}>
          clear selection
        </button>
        <button className="danger" role="menuitem" onClick={all(() => {
          L2.deleteNodes(selection);
          useUi.getState().set({ selection: [] });
        })}>
          delete {n} nodes (and their children)
        </button>
      </div>
    );
  }
  const L = useLoom.getState();
  const isRoot = !!node.isRoot;
  const act = (fn: () => void) => () => {
    fn();
    close();
  };

  const doExport = async () => {
    const md = exportMarkdown(useLoom.getState().nodes, node.id);
    let copied = false;
    try {
      await navigator.clipboard.writeText(md);
      copied = true;
    } catch {
      /* clipboard refused */
    }
    try {
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-${node.id}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* downloads blocked */
    }
    L.showToast(copied ? 'Chat copied to clipboard and saved as markdown' : 'Chat saved as markdown');
  };

  return (
    <div className={`node-menu${place.subClass}`} style={place.style} ref={ref} role="menu">
      <button className="danger" role="menuitem" disabled={isRoot} onClick={act(() => L.deleteSubtree(node.id))}>
        delete node (and its children)
      </button>
      <button role="menuitem" disabled={isRoot} onClick={act(() => L.hideNode(node.id))}>
        hide node (and its children)
      </button>
      <button role="menuitem" disabled={!canShow} onClick={act(() => L.showAllBelow(node.id))}>
        show all children of this node
      </button>
      <button role="menuitem" disabled={canMerge !== true} title={canMerge === true ? 'join this node onto the end of its parent (M)' : canMerge} onClick={act(() => L.mergeIntoParent(node.id))}>
        merge into parent
      </button>
      <div className="has-sub" ref={forkRow} onPointerEnter={(e) => e.pointerType === 'mouse' && setSub(true)} onPointerLeave={(e) => e.pointerType === 'mouse' && setSub(false)}>
        <button role="menuitem" aria-haspopup="menu" aria-expanded={sub} onClick={() => setSub(true)}>
          fork from here <span className="chev">›</span>
        </button>
        {sub && (
          <Flyout anchor={forkRow}>
            <button role="menuitem" disabled={isRoot} onClick={act(() => L.forkGenerate(node.id))}>
              generate 1 branch
            </button>
            <button role="menuitem" disabled={isRoot} onClick={act(() => L.forkMany(node.id, 3))}>
              generate 3 branches
            </button>
            <button role="menuitem" onClick={act(() => L.forkForWriting(node.id))}>
              write the next message
            </button>
          </Flyout>
        )}
      </div>
      <button role="menuitem" disabled={isRoot} onClick={act(() => L.openNodeIn(node.id, 'tab'))}>
        open in new tab
      </button>
      {!mobile && (
        <button role="menuitem" disabled={isRoot || windowsFull} title={windowsFull ? `${MAX_WINDOWS} windows are already open` : undefined} onClick={act(() => L.openNodeIn(node.id, 'window'))}>
          open in new window
        </button>
      )}
      <button role="menuitem" disabled={isRoot} onClick={act(() => void doExport())}>
        export chat up to this point
      </button>
    </div>
  );
}

export function Toast() {
  const toast = useLoom((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className="toast" role="status">
      {toast.text}
    </div>
  );
}
