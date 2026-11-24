import { useEffect, type CSSProperties } from 'react';
import { useIsMobile } from './useIsMobile';
import { useUi } from './store';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './canvas/Canvas';
import { NodeMenu, NodeTooltip, Toast } from './canvas/Overlays';
import { MobileChat, Sidebar } from './chat/Sidebar';
import { sideWidth, useLoom } from './store';

/** ctrl/cmd + z undoes, ctrl/cmd + y or ctrl/cmd + shift + z redoes. Text fields keep their own undo. */
function useUndoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        useLoom.getState().undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        useLoom.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}


/**
 * Moving through the tree from the keyboard (the chat you're in follows): arrows for parent,
 * child and siblings; G generates a branch (shift: three); M merges into the parent. Never while
 * typing, with a menu or panel open, or with ctrl/cmd/alt held.
 */
function useTreeKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
      if (useUi.getState().menu || useUi.getState().tabDrag || document.querySelector('.node-menu, .settings')) return;
      const L = useLoom.getState();
      const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (dirs[e.key]) {
        e.preventDefault();
        L.navigate(dirs[e.key]);
        return;
      }
      if (e.repeat) return;
      const head = L.tabs.find((x) => x.id === L.activeTabId)?.headId;
      if (!head) return;
      const k = e.key.toLowerCase();
      if (k === 'g') {
        e.preventDefault();
        // an empty chat has nothing to branch from (its robot buttons let the model speak first)
        if (L.nodes[head]?.isRoot) L.showToast('Nothing to branch from yet: write a first message.');
        else L.forkMany(head, e.shiftKey ? 3 : 1);
      } else if (k === 'm' && !e.shiftKey) {
        e.preventDefault();
        L.mergeIntoParent(head);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * The chat windows float over the left of the canvas instead of squeezing it, so opening, closing
 * or resizing them never moves the canvas. Their width (straight from the store) goes into
 * --side-w so the canvas's own left-hand controls sit just right of them.
 */
function SideLayer() {
  return (
    <div className="side-layer">
      <Sidebar />
    </div>
  );
}

export function App() {
  useUndoKeys();
  useTreeKeys();
  const mobile = useIsMobile();
  // on a phone the sidebar toggle swaps between the chat and the tree: only one is rendered
  const showChat = useLoom((s) => !s.sidebarFolded && s.tabs.length > 0);
  const side = useLoom((s) => (mobile ? 0 : sideWidth(s)));
  return (
    <ReactFlowProvider>
      <div className={`app${mobile ? ' mobile' : ''}`}>
        <main className="workspace" style={{ '--side-w': `${side}px` } as CSSProperties}>
          {mobile ? (
            showChat ? <MobileChat /> : <Canvas />
          ) : (
            <>
              <Canvas />
              <SideLayer />
            </>
          )}
        </main>
        <NodeTooltip />
        <NodeMenu />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
