import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FORMAT_PRESETS, PRESETS, apiKeyFor, isAcs, useSettings, type ModelProfile, type Preset } from './settings';
import { parseExtra, renderPrompt } from './generate';
import { useLoom } from './store';
import { modelConfig } from './model/client';

/*
 * Settings: a panel over the canvas's right side. Models (several can be on at once: branches
 * take turns between them), sampling, and how a conversation is written out for a base model.
 */

export function SettingsButton() {
  const open = useSettings((s) => s.open);
  return (
    <button
      className="icon-btn big"
      onClick={() => useSettings.getState().setOpen(!open)}
      title="Settings: models and sampling"
      aria-label="Settings"
      aria-pressed={open}
    >
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M10 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm6.7 4.6.1-1.2-.1-1.2 1.6-1.3-1.6-2.8-2 .7a6.5 6.5 0 0 0-2-1.2L12.3 2H9l-.4 2.1a6.5 6.5 0 0 0-2 1.2l-2-.7L3 7.4l1.6 1.3-.1 1.3.1 1.2L3 12.6l1.6 2.8 2-.7c.6.5 1.3.9 2 1.2L9 18h3.3l.4-2.1c.7-.3 1.4-.7 2-1.2l2 .7 1.6-2.8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  );
}

function Num({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  // keep what you type until it's a number in range, so clearing the box to retype doesn't snap it
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(v) && v >= min && v <= max) onChange(v);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/** What the two kinds of served model do, in the words the panel uses. */
const KIND = {
  completions: {
    name: 'base model',
    what: 'continues the text',
    more: 'Sees the chat written out as one document (see "How base models see the chat" below) and carries it on: it can write either voice, or finish any half-written message. Best for looming.',
  },
  chat: {
    name: 'chat model',
    what: 'replies as the assistant',
    more: "Gets the messages through its own chat template and writes the assistant's reply. It can't write as you, and finishes a half-written reply only if the server supports prefill.",
  },
};

function KindBadge({ m }: { m: ModelProfile }) {
  const text = m.mode === 'demo' ? 'demo' : m.mode === 'browser' ? 'in this page' : m.mode === 'chat' ? 'chat' : 'base';
  return <span className={`kind-badge ${m.mode}`}>{text}</span>;
}

function ModelCard({ m }: { m: ModelProfile }) {
  const S = useSettings.getState();
  const key = useSettings((s) => s.keys[m.id] ?? '');
  const [found, setFound] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const extraErr = m.extra.trim() ? (('error' in parseExtra(m.extra) && (parseExtra(m.extra) as { error: string }).error) || null) : null;
  const devKey = isAcs(m) && !key && !!apiKeyFor(m);
  const up = (patch: Partial<ModelProfile>) => S.updateModel(m.id, patch);

  const check = async () => {
    setChecking(true);
    try {
      const k = apiKeyFor(m);
      const res = await fetch(`${m.baseUrl.trim().replace(/\/+$/, '')}/models`, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const j = (await res.json()) as { data?: { id: string; status?: string }[] };
      const ids = (j.data ?? []).map((d) => d.id);
      setFound(ids);
      useLoom.getState().showToast(ids.length ? `Connected: ${ids.length} model${ids.length > 1 ? 's' : ''} available` : 'Connected, but the server listed no models');
    } catch (e) {
      setFound(null);
      useLoom.getState().showToast(`Couldn't reach ${m.label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={`model-card${m.on ? ' on' : ''}`}>
      <div className="model-head">
        <label className="set-check" title="Use this model for new branches">
          <input type="checkbox" checked={m.on} onChange={(e) => up({ on: e.target.checked })} />
          <input className="model-label" value={m.label} onChange={(e) => up({ label: e.target.value })} aria-label="Model label" />
        </label>
        <KindBadge m={m} />
        {m.mode !== 'demo' && m.mode !== 'browser' && (
          <button type="button" className="set-link danger" onClick={() => S.removeModel(m.id)}>
            remove
          </button>
        )}
      </div>
      {m.mode === 'demo' ? (
        <p className="set-hint">Lorem ipsum with made-up probabilities. No server needed, for trying the interface out.</p>
      ) : m.mode === 'browser' ? (
        <p className="set-hint">
          A small chat model ({modelConfig.model}) running in this page: downloads once, up to 790 MB. It carries on whichever message is
          open, so it can write either voice. It reports no probabilities. Change it from the address: ?model= &amp;temp= &amp;max= &amp;device=wasm.
        </p>
      ) : (
        <>
          {isAcs(m) ? (
            <p className="set-hint">ACS serves base models only: they continue the chat as text, in either voice.</p>
          ) : (
            <div className="kind-pick" role="radiogroup" aria-label="What kind of model this is">
              {(['completions', 'chat'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={m.mode === k} className={m.mode === k ? 'on' : ''} onClick={() => up({ mode: k })}>
                  <span className="kind-name">{KIND[k].name}</span>
                  <span className="kind-what">{KIND[k].what}</span>
                </button>
              ))}
            </div>
          )}
          {!isAcs(m) && <p className="set-hint">{KIND[m.mode as 'completions' | 'chat'].more}</p>}
          <Field label="endpoint">
            <input value={m.baseUrl} onChange={(e) => up({ baseUrl: e.target.value })} placeholder="http://localhost:8080/v1" spellCheck={false} />
          </Field>
          <Field
            label="model"
            hint={isAcs(m) ? 'llama-8b, llama-405b or trinity-truebase. Idle models are shut down: the first request can wait while one starts (minutes for the big two).' : undefined}
          >
            <input value={m.model} onChange={(e) => up({ model: e.target.value })} list={`models-${m.id}`} placeholder="(server default)" spellCheck={false} />
            {found && (
              <datalist id={`models-${m.id}`}>
                {found.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            )}
          </Field>
          <Field
            label="API key"
            hint={devKey ? 'Using ACS_API_KEY from .env (dev server only).' : 'Kept in this browser only; never put in an exported loom.'}
          >
            <input type="password" value={key} onChange={(e) => S.setKey(m.id, e.target.value)} placeholder={devKey ? 'from .env' : 'none'} autoComplete="off" />
          </Field>
          {m.mode === 'chat' && (
            <label className="set-check" title="llama-server does this; vLLM needs {&quot;continue_final_message&quot;: true, &quot;add_generation_prompt&quot;: false} in the extra JSON">
              <input type="checkbox" checked={m.prefill} onChange={(e) => up({ prefill: e.target.checked })} />
              can finish a half-written reply (the server supports prefill)
            </label>
          )}
          <Field label="extra request JSON" hint={extraErr ?? (isAcs(m) ? 'ACS also takes top_k, min_p, repetition_penalty, presence_penalty, seed. Unknown fields are rejected.' : undefined)}>
            <textarea className={extraErr ? 'bad' : ''} rows={2} value={m.extra} onChange={(e) => up({ extra: e.target.value })} placeholder='{"top_k": 40}' spellCheck={false} />
          </Field>
          <button type="button" className="set-btn" onClick={() => void check()} disabled={checking || !m.baseUrl.trim()}>
            {checking ? 'checking…' : 'check connection'}
          </button>
        </>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const open = useSettings((s) => s.open);
  const models = useSettings((s) => s.models);
  const sampling = useSettings((s) => s.sampling);
  const format = useSettings((s) => s.format);
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const S = useSettings.getState();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && S.setOpen(false);
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, S]);

  if (!open) return null;
  const onCount = models.filter((m) => m.on).length;
  const hasCompletions = models.some((m) => m.mode === 'completions');
  const example = renderPrompt(
    [
      { role: 'user', text: 'what does the moon want?' },
      { role: 'model', text: '' },
    ],
    format,
  ).prompt;

  return (
    <aside className="settings" ref={ref} tabIndex={-1} aria-label="Settings">
      <header className="set-top">
        <h2>Settings</h2>
        <button className="icon-btn" onClick={() => S.setOpen(false)} aria-label="Close settings" title="Close (esc)">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <section>
        <h3>Models</h3>
        <p className="set-hint">
          Base models continue text, in either voice: the loom's natural fit. Chat models reply as the assistant.{' '}
          {onCount === 0
            ? 'No model is on: switch one on to generate.'
            : onCount === 1
              ? 'Branches are written by the model that is on.'
              : `${onCount} models are on: new branches take turns between them.`}
        </p>
        {models.map((m) => (
          <ModelCard key={m.id} m={m} />
        ))}
        {adding ? (
          <div className="set-row">
            {(Object.keys(PRESETS) as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                className="set-btn"
                onClick={() => {
                  S.addModel(p);
                  setAdding(false);
                }}
              >
                {PRESETS[p].name}
              </button>
            ))}
            <button type="button" className="set-link" onClick={() => setAdding(false)}>
              cancel
            </button>
          </div>
        ) : (
          <button type="button" className="set-btn" onClick={() => setAdding(true)}>
            + add a model
          </button>
        )}
      </section>

      <section>
        <h3>Sampling</h3>
        <div className="set-grid">
          <Field label="temperature">
            <Num value={sampling.temperature} min={0} max={5} step={0.05} onChange={(v) => S.setSampling({ temperature: v })} />
          </Field>
          <Field label="top p">
            <Num value={sampling.topP} min={0} max={1} step={0.01} onChange={(v) => S.setSampling({ topP: v })} />
          </Field>
          <Field label="max tokens">
            <Num value={sampling.maxTokens} min={1} max={4000} step={1} onChange={(v) => S.setSampling({ maxTokens: Math.round(v) })} />
          </Field>
          <Field label="alternatives">
            <Num value={sampling.alts} min={0} max={10} step={1} onChange={(v) => S.setSampling({ alts: Math.round(v) })} />
          </Field>
        </div>
        <p className="set-hint">Alternatives: how many other tokens to record at each position (0 records no probabilities).</p>
      </section>

      <section>
        <h3>How base models see the chat</h3>
        <p className="set-hint">
          A base model only continues text, so the chat is written out as one document and the model writes what comes next.
          {hasCompletions ? '' : ' (No base model is set up: this only matters once you add one.)'} The preamble goes first; chat models get it as their
          system message.
        </p>
        <Field label="format">
          <select
            value={format.preset}
            onChange={(e) => {
              const v = e.target.value as typeof format.preset;
              S.setFormat(v === 'custom' ? { preset: v } : { preset: v, ...FORMAT_PRESETS[v] });
            }}
          >
            <option value="transcript">transcript (User: / Assistant:)</option>
            <option value="raw">raw text (messages run together)</option>
            <option value="custom">custom</option>
          </select>
        </Field>
        {format.preset === 'custom' && (
          <div className="set-grid">
            <Field label="user prefix">
              <input value={format.user} onChange={(e) => S.setFormat({ user: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="assistant prefix">
              <input value={format.model} onChange={(e) => S.setFormat({ model: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="between messages" hint="\n is a new line">
              <input
                value={format.sep.replace(/\n/g, '\\n')}
                onChange={(e) => S.setFormat({ sep: e.target.value.replace(/\\n/g, '\n') })}
                spellCheck={false}
              />
            </Field>
          </div>
        )}
        <Field label="preamble">
          <textarea rows={2} value={format.preamble} onChange={(e) => S.setFormat({ preamble: e.target.value })} placeholder="(none)" />
        </Field>
        <span className="set-label">what the model sees</span>
        <pre className="set-preview">{example}</pre>
      </section>

    </aside>
  );
}
