import { ModelPill } from './model/ModelPill';
import { useLoom } from './store';
import { SettingsButton } from './SettingsPanel';
import { useSettings } from './settings';
import { TITLE_EYES, TITLE_INK, TITLE_SLASH, TITLE_VIEWBOX } from './mindscapesTitle';

/* The only controls outside the canvas tools: floating over the canvas's top corners. */

export function Wordmark() {
  return (
    <h1 className="wordmark">
      <svg className="wm" viewBox={TITLE_VIEWBOX} role="img" aria-label="mindscapes / loom">
        <path className="wm-ink" d={TITLE_INK} />
        <path className="wm-slash" d={TITLE_SLASH} />
        {TITLE_EYES.map((e, i) => (
          <g key={i}>
            <circle className="wm-eye" cx={e.cx} cy={e.cy} r={e.r - 26} />
            <circle className="wm-pupil" cx={e.cx + e.r * 0.14} cy={e.cy + e.r * 0.12} r={e.r * 0.4} />
          </g>
        ))}
      </svg>
    </h1>
  );
}

/** Shows/hides the chat sidebar (on a phone: swaps between the chat and the tree). */
export function SidebarToggle() {
  const folded = useLoom((s) => s.sidebarFolded);
  return (
    <button
      className="icon-btn big"
      onClick={() => useLoom.getState().toggleSidebar()}
      title={folded ? 'Show threads' : 'Hide threads'}
      aria-label={folded ? 'Show threads' : 'Hide threads'}
      aria-pressed={!folded}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 3.5v13" stroke="currentColor" strokeWidth="1.6" />
        {!folded && <rect x="3.5" y="4.5" width="3.6" height="11" rx="1" fill="currentColor" opacity="0.35" />}
      </svg>
    </button>
  );
}

/** Top left of the canvas, right beside the chat sidebar: the sidebar toggle, then the title. */
export function ChromeLeft() {
  const hasTabs = useLoom((s) => s.tabs.length > 0);
  return (
    <div className="chrome chrome-left">
      {hasTabs && <SidebarToggle />}
      <Wordmark />
    </div>
  );
}

/** Top right of the canvas: the model, then undo and redo. */
export function ChromeRight() {
  const canUndo = useLoom((s) => s.past.length > 0);
  // the in-browser model's state, while it is one of the models in use
  const browserOn = useSettings((s) => s.models.some((m) => m.on && m.mode === 'browser'));
  const canRedo = useLoom((s) => s.future.length > 0);
  const L = useLoom.getState();
  return (
    <div className="chrome chrome-right">
      {browserOn && <ModelPill />}
      <button className="icon-btn big" onClick={() => L.undo()} disabled={!canUndo} title="Undo (ctrl z)" aria-label="Undo">
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <path d="M7 5 3 9l4 4M3.5 9H12a4.5 4.5 0 0 1 0 9H9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="icon-btn big" onClick={() => L.redo()} disabled={!canRedo} title="Redo (ctrl y)" aria-label="Redo">
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <path d="m13 5 4 4-4 4M16.5 9H8a4.5 4.5 0 0 0 0 9h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <SettingsButton />
    </div>
  );
}

