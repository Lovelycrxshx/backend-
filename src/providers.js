// Free-tier LLM providers from https://github.com/mnfst/awesome-free-llm-apis
// Every entry speaks the OpenAI wire format, so the gateway only has to swap
// base URL + API key + model name.
//
// Each provider can be overridden, and new ones added, with env vars:
//   <ID>_BASE_URL   <ID>_API_KEY   <ID>_MODEL
// e.g. GROQ_BASE_URL, GROQ_MODEL, ALPHA_BASE_URL...
// An id in PROVIDER_ORDER that isn't listed below becomes a provider as soon as
// <ID>_BASE_URL is set — that's the escape hatch for any OpenAI-compatible API.

export const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemma-4-31b-it'],
    notes: 'Free tier, no credit card. Free-tier prompts may be used to improve Google products.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    notes: 'Free tier, no credit card. Very fast LPU inference.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    defaultModel: 'nvidia/nemotron-3.5-lightning:free',
    models: [
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-31b-it:free',
    ],
    notes: 'Only models with the :free suffix are free. 20 RPM / 50 requests per day.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    signupUrl: 'https://cloud.cerebras.ai/',
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'gemma-4-31b'],
    notes: 'Free tier with a payment method on file. Extremely fast.',
  },
  {
    id: 'ovhcloud',
    label: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    keyEnv: 'OVHCLOUD_API_KEY',
    keyless: true,
    signupUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/',
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'Qwen3.5-397B-A17B', 'Meta-Llama-3_3-70B-Instruct'],
    notes: 'Anonymous free tier: no key, 2 requests/min per IP. Handy instant fallback.',
  },
  {
    id: 'llm7',
    label: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    keyEnv: 'LLM7_API_KEY',
    keyless: true,
    signupUrl: 'https://token.llm7.io/',
    defaultModel: 'gpt-oss:20b',
    models: ['gpt-oss:20b', 'codestral-latest', 'mistral-Nemo-Instruct-2407'],
    notes: 'No key needed for turbo models. Undocumented limits, can disappear without notice.',
  },
];

const DEFAULT_ORDER = 'gemini,groq,openrouter,ovhcloud,llm7';
const truthy = (v) => /^(1|true|yes|on)$/i.test(v ?? '');
const upper = (id) => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** Overlay env overrides onto a provider definition. */
function withOverrides(def, getEnv) {
  const up = upper(def.id);
  return {
    ...def,
    key: getEnv(def.keyEnv) || '',
    baseUrl: getEnv(`${up}_BASE_URL`) ?? def.baseUrl,
    defaultModel: getEnv(`${up}_MODEL`) ?? def.defaultModel,
  };
}

/** A provider that exists only because env vars define it. */
function adHocProvider(id, getEnv) {
  const up = upper(id);
  const baseUrl = getEnv(`${up}_BASE_URL`);
  if (!baseUrl) return null;
  const model = getEnv(`${up}_MODEL`) ?? '';
  return {
    id,
    label: getEnv(`${up}_LABEL`) ?? id,
    baseUrl,
    keyEnv: `${up}_API_KEY`,
    key: getEnv(`${up}_API_KEY`) ?? '',
    keyless: true, // keyless only when no key env is set; resolveProviders filters
    defaultModel: model,
    models: [model].filter(Boolean),
    signupUrl: null,
    notes: 'Configured through environment variables.',
  };
}

/**
 * Providers usable right now (key present, or keyless), in fallback order.
 */
export function resolveProviders(getEnv) {
  const order = (getEnv('PROVIDER_ORDER') ?? DEFAULT_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const noKeyless = truthy(getEnv('DISABLE_KEYLESS'));
  const out = [];
  const seen = new Set();

  for (const alias of order) {
    if (seen.has(alias)) continue;
    seen.add(alias);

    const builtin = PROVIDERS.find((p) => p.id === alias);
    const provider = builtin ? withOverrides(builtin, getEnv) : adHocProvider(alias, getEnv);
    if (!provider) continue;

    const hasKey = Boolean(provider.key);
    const isKeylessAllowed =
      hasKey ||
      (!noKeyless && builtin?.keyless) ||
      (!builtin && !getEnv(`${upper(alias)}_API_KEY`)); // ad-hoc provider with only a base URL
    if (!isKeylessAllowed) continue;
    if (provider.defaultModel === '' && !hasKey && builtin) continue;

    out.push({ ...provider, keyless: !hasKey });
  }

  return out;
}

/** Friendly list for /v1/providers — never includes keys. */
export function describeProviders(getEnv) {
  const active = new Map(resolveProviders(getEnv).map((p) => [p.id, p]));
  const known = PROVIDERS.map((p) => {
    const live = active.get(p.id);
    return {
      id: p.id,
      label: p.label,
      configured: Boolean(live),
      keyless: Boolean(p.keyless),
      default_model: live?.defaultModel ?? p.defaultModel,
      models: live?.models?.length ? live.models : p.models,
      signup_url: p.signupUrl,
      notes: p.notes,
    };
  });
  const extra = [...active.values()]
    .filter((p) => !PROVIDERS.some((known) => known.id === p.id))
    .map((p) => ({
      id: p.id,
      label: p.label,
      configured: true,
      keyless: p.keyless,
      default_model: p.defaultModel,
      models: p.models,
      signup_url: p.signupUrl,
      notes: p.notes,
    }));
  return [...known, ...extra];
}
