import { useEffect, type CSSProperties } from 'react';
import { useIsMobile } from './useIsMobile';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './canvas/Canvas';
import { NodeMenu, NodeTooltip, Toast } from './canvas/Overlays';
import { MobileChat, Sidebar } from './chat/Sidebar';
import { sideWidth, useLoom } from './store';
import { SettingsPanel } from './SettingsPanel';

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
        <SettingsPanel />
        <NodeTooltip />
        <NodeMenu />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
