import { create } from 'zustand';

/*
 * Model and generation settings. Kept apart from the loom (they are yours, not the tree's), saved
 * in localStorage. API keys are saved under a key of their own and never leave this browser:
 * they are not part of the settings object, nor of an exported loom file.
 */

/** demo: the built-in lorem shim (with made-up probabilities), for trying the interface offline */
/** browser: Megan's in-page model (model/), configured from the address */
export type Mode = 'demo' | 'completions' | 'chat' | 'browser';

export interface ModelProfile {
  id: string;
  label: string;
  mode: Mode;
  /** e.g. http://localhost:8080/v1 ; /completions or /chat/completions is added */
  baseUrl: string;
  /** the `model` field sent with each request (may be empty for llama-server) */
  model: string;
  /** chat mode: the backend continues a final assistant message instead of answering it */
  prefill: boolean;
  /** extra JSON merged into each request body */
  extra: string;
  /** used for generation */
  on: boolean;
}

export interface Sampling {
  temperature: number;
  maxTokens: number;
  topP: number;
  /** how many alternatives to record per token (0 turns logprobs off) */
  alts: number;
}

/** How a conversation is written out as one document for a completions (base) model. */
export interface Format {
  preset: 'transcript' | 'raw' | 'custom';
  user: string;
  model: string;
  /** between messages */
  sep: string;
  /** text before the conversation (in chat mode: a system message) */
  preamble: string;
}

export const FORMAT_PRESETS: Record<'transcript' | 'raw', Omit<Format, 'preset' | 'preamble'>> = {
  transcript: { user: 'User: ', model: 'Assistant: ', sep: '\n\n' },
  raw: { user: '', model: '', sep: '' },
};

export interface SettingsState {
  models: ModelProfile[];
  sampling: Sampling;
  format: Format;
  /** fade tokens by how likely the model thought they were */
  shade: boolean;
  keys: Record<string, string>;
  open: boolean;
  setOpen(open: boolean): void;
  addModel(preset: Preset): void;
  updateModel(id: string, patch: Partial<ModelProfile>): void;
  removeModel(id: string): void;
  setKey(id: string, key: string): void;
  setSampling(patch: Partial<Sampling>): void;
  setFormat(patch: Partial<Format>): void;
  setShade(on: boolean): void;
}

// the interview build's own (it shares a site with the loom)
const SETTINGS_KEY = 'mindscapes-loom-interview-settings-v1';
const KEYS_KEY = 'mindscapes-loom-interview-api-keys-v1';

const DEMO: ModelProfile = { id: 'demo', label: 'demo', mode: 'demo', baseUrl: '', model: '', prefill: false, extra: '', on: false };
const BROWSER: ModelProfile = { id: 'browser', label: 'in this browser', mode: 'browser', baseUrl: '', model: '', prefill: false, extra: '', on: true };

/** ACS Infra v2 (docs: https://docs.v2.infra.acsresearch.org). v1 lived at infra.acsresearch.org/v1. */
export const ACS_BASE = 'https://api.v2.infra.acsresearch.org/v1';
const ACS_V1_BASE = /^https:\/\/infra\.acsresearch\.org\/v1\/?$/;
export const isAcs = (m: Pick<ModelProfile, 'baseUrl'>) => m.baseUrl.includes('infra.acsresearch.org');

/**
 * `npm run dev` only: ACS_API_KEY from .env, put in by vite.config.ts. Production builds get an
 * empty string, so a key never ends up in a deployed bundle; there you paste it into settings.
 */
export const DEV_ACS_KEY: string = typeof __DEV_ACS_KEY__ === 'string' ? __DEV_ACS_KEY__ : '';

/** The key for a model: the one typed in settings, else (in dev) the .env key for ACS models. */
export function apiKeyFor(m: ModelProfile): string | undefined {
  return useSettings.getState().keys[m.id] || (isAcs(m) && DEV_ACS_KEY ? DEV_ACS_KEY : undefined);
}

export type Preset = 'acs' | 'local' | 'openai-chat';
export const PRESETS: Record<Preset, { name: string; profile: Omit<ModelProfile, 'id' | 'on'> }> = {
  acs: {
    name: 'ACS (base models)',
    profile: { label: 'llama-8b', mode: 'completions', baseUrl: ACS_BASE, model: 'llama-8b', prefill: false, extra: '' },
  },
  local: {
    name: 'llama-server (base model)',
    profile: { label: 'local', mode: 'completions', baseUrl: 'http://localhost:8080/v1', model: '', prefill: false, extra: '' },
  },
  'openai-chat': {
    name: 'chat model (OpenAI-style)',
    profile: { label: 'chat', mode: 'chat', baseUrl: 'https://api.openai.com/v1', model: '', prefill: false, extra: '' },
  },
};

const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
let seq = 0;

const defaults = () => ({
  // the in-browser model by default; with a dev key, ACS's always-warm base model instead.
  // The demo (lorem, no download) stays for trying the interface offline.
  models: DEV_ACS_KEY
    ? [{ ...BROWSER, on: false }, DEMO, { ...PRESETS.acs.profile, id: 'acs-llama-8b', on: true }]
    : [BROWSER, DEMO],
  sampling: { temperature: 1, maxTokens: 120, topP: 1, alts: 5 } as Sampling,
  format: { preset: 'transcript', ...FORMAT_PRESETS.transcript, preamble: '' } as Format,
  shade: true,
});

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Saved settings from before a built-in model existed get it too (switched off). */
function withBuiltins(models: ModelProfile[]): ModelProfile[] {
  const out = models.slice();
  for (const b of [BROWSER, DEMO]) if (!out.some((m) => m.id === b.id)) out.push({ ...b, on: false });
  // ACS moved to v2: same model ids and keys, new address
  return out.map((m) => (ACS_V1_BASE.test(m.baseUrl.trim()) ? { ...m, baseUrl: ACS_BASE } : m));
}

function loadSettings() {
  const d = defaults();
  const s = read<Partial<ReturnType<typeof defaults>>>(SETTINGS_KEY);
  return {
    models: Array.isArray(s?.models) && s.models.length ? withBuiltins(s.models.map((m) => ({ ...DEMO, ...m }))) : d.models,
    sampling: { ...d.sampling, ...s?.sampling },
    format: { ...d.format, ...s?.format },
    shade: s?.shade ?? d.shade,
    keys: read<Record<string, string>>(KEYS_KEY) ?? {},
  };
}

export const useSettings = create<SettingsState>()((set) => ({
  ...loadSettings(),
  open: false,
  setOpen: (open) => set({ open }),
  addModel: (preset) =>
    set((s) => {
      const p = PRESETS[preset].profile;
      // labels name a model in the token tips, so keep them distinct
      let label = p.label;
      for (let i = 2; s.models.some((m) => m.label === label); i++) label = `${p.label} ${i}`;
      return { models: [...s.models, { ...p, label, id: newId(), on: true }] };
    }),
  updateModel: (id, patch) => set((s) => ({ models: s.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  removeModel: (id) =>
    set((s) => {
      const keys = { ...s.keys };
      delete keys[id];
      return { models: s.models.filter((m) => m.id !== id), keys };
    }),
  setKey: (id, key) => set((s) => ({ keys: { ...s.keys, [id]: key } })),
  setSampling: (patch) => set((s) => ({ sampling: { ...s.sampling, ...patch } })),
  setFormat: (patch) => set((s) => ({ format: { ...s.format, ...patch } })),
  setShade: (shade) => set({ shade }),
}));

useSettings.subscribe((s) => {
  try {
    const { models, sampling, format, shade } = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ models, sampling, format, shade }));
    localStorage.setItem(KEYS_KEY, JSON.stringify(s.keys));
  } catch {
    /* storage unavailable: settings last for this visit */
  }
});

let turn = 0;

/**
 * The model for the next generation: `prefer` (by label) if it is switched on, else the switched-on
 * models in turn, so "generate 3 branches" with two models on spreads them across both.
 */
export function pickModel(prefer?: string): ModelProfile | null {
  const on = useSettings.getState().models.filter((m) => m.on);
  if (!on.length) return null;
  const p = prefer ? on.find((m) => m.label === prefer) : undefined;
  return p ?? on[turn++ % on.length];
}
