# Free LLM APIs on your Android phone

This repo doubles as a small **OpenAI-compatible gateway** in front of the free
providers listed in
[awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis#inference-providers).
Point one Android app at one URL; the gateway holds the provider keys and falls
back down the list when a free tier rate-limits you.

```
Android app  ──►  https://<your-host>/v1  ──►  Gemini ─► Groq ─► OpenRouter ─► OVHcloud ─► LLM7
      (one token)          (this backend)              (first one that answers wins)
```

Works two ways:

| Path | What the phone holds | Use when |
| --- | --- | --- |
| **Through this backend** (recommended) | the single `GATEWAY_TOKEN` | you want fallback between providers and keys off the device |
| **Direct from the app** | each provider's own key | you don't want to run a server at all |

---

## 1. Get free keys (2 minutes each)

| Provider | Sign up | Free tier | Base URL |
| --- | --- | --- | --- |
| **Google Gemini** | <https://aistudio.google.com/app/apikey> | no card; 1M context, multimodal | `https://generativelanguage.googleapis.com/v1beta/openai` |
| **Groq** | <https://console.groq.com/keys> | no card; very fast, 30 req/min | `https://api.groq.com/openai/v1` |
| **OpenRouter** | <https://openrouter.ai/keys> | `:free` models, 20 req/min, 50/day | `https://openrouter.ai/api/v1` |
| **Cerebras** | <https://cloud.cerebras.ai/> | card on file; fastest inference | `https://api.cerebras.ai/v1` |
| **OVHcloud** | nothing | anonymous, 2 req/min | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` |
| **LLM7.io** | nothing | no key for turbo models | `https://api.llm7.io/v1` |

You said you already have Groq and/or Gemini — those two alone are enough.

## 2. Turn on the gateway

### Locally (for testing)

```bash
npm install
cp .env.example .env          # fill in GROQ_API_KEY / GEMINI_API_KEY + GATEWAY_TOKEN
npm test                      # 15 tests, no quota used
npm start                     # http://localhost:3000
```

### Railway (what this repo already deploys to)

1. Repo → **Variables** → add `GATEWAY_TOKEN` (`openssl rand -hex 32`), plus
   `GROQ_API_KEY` and `GEMINI_API_KEY`.
2. Redeploy. Your base URL is `https://<your-service>.up.railway.app/v1`.

### Cloudflare Workers (later home)

`src/app.js` has no Node-only imports, so `export default app` deploys as-is.

## 3. Install the app on the phone

**Recommended: [ChatterUI](https://github.com/Vali-98/ChatterUI/releases/latest)**
— open source, no Play Store account needed, has a *Generic Chat Completions*
connection type that accepts any OpenAI-compatible base URL.

1. Download the APK from the releases page and install it.
2. Left menu → **API** → **Create Connection**.
3. Type **Generic** → **Chat Completions**.
4. **Endpoint:** `https://<your-service>.up.railway.app/v1`
   (ChatterUI appends `/chat/completions` itself — don't add it).
5. **API Key:** your `GATEWAY_TOKEN`.
6. **Model:** `auto` (the gateway chooses), or pin a provider with a namespaced
   id like `groq/openai/gpt-oss-120b`. Get the current list from
   `GET /v1/models` or open `/setup` on the phone.

**Alternative: [Chatbox](https://chatboxai.app/)** (Play Store). Settings → AI
Provider → *Add Custom Provider* → **OpenAI API Compatible** → API Host =
`https://<your-service>.up.railway.app/v1`, key = `GATEWAY_TOKEN`.

Open `https://<your-service>.up.railway.app/setup` **on the phone** for a
copy-paste card with the exact values. Provider keys are never rendered there.

### Direct mode (no backend)

In ChatterUI pick **OpenAI**, endpoint `https://api.groq.com/openai/v1`, key =
your Groq key, model list → refresh. There is no cross-provider fallback this
way, so if you hit a rate limit you switch connections by hand.

## What the gateway adds

- **Fallback chain.** 429/5xx/timeouts move to the next provider; a provider that
  just failed is skipped for 45 s (`PROVIDER_COOLDOWN_MS`).
- **Honest errors.** 4xx from a provider is *not* retried elsewhere — a bad
  request is a bad request.
- **Safe streaming.** The upstream stream is peeked at before responding, so a
  provider that returns 200 and then errors is still replaced silently.
- **One secret on the device.** Provider keys never leave the server.
- **Diagnostics.** `X-Gateway-Provider` / `X-Gateway-Model` headers, and a JSON
  `attempts` trail when everything fails.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | Bearer `GATEWAY_TOKEN` | OpenAI-compatible chat (stream + non-stream) |
| `GET /v1/models` | Bearer | Configured models, namespaced `provider/model` |
| `GET /v1/providers` | Bearer | Which providers are active (never shows keys) |
| `GET /setup` | none | Phone-sized setup card |
| `GET /setup/cheatsheet` | none | Plain-text values for the app |
| `GET /health`, `/api/*` | none | The original routes, unchanged |

`model` accepts:

- `auto` — gateway's fallback order, provider default models
- `groq/openai/gpt-oss-120b` — namespaced: route to Groq with that model
- `openai/gpt-oss-120b` — a model the gateway recognises: routed to its owner
- anything else — passed through to the first provider (which may reject it)

### curl smoke test

```bash
curl -s https://<host>/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

## Notes on free tiers

- Free quotas are **per account**, so use your own keys. Anonymous providers
  (OVHcloud, LLM7) rate-limit by IP — 2 req/min is shared with everyone on the
  same network, so they're fallbacks, not primaries.
- Gemini's free tier may use prompts to improve Google products; don't send
  anything private. `DISABLE_KEYLESS=1` removes the anonymous providers.
- OpenRouter only gives away models with the `:free` suffix.
- Provider model lists drift. `GET /v1/models` reflects this repo's
  `src/providers.js`; override any of it with `<ID>_MODEL` env vars, or add a
  brand-new provider with `<ID>_BASE_URL` + `<ID>_MODEL` and no code change.

## Tests

```bash
npm test
```

The suite fakes every upstream, so it runs offline and never spends quota. It
covers auth, fallback order, cooldown, streaming passthrough, junk-stream
fallback, the model catalogue, the setup card, and that the original
`/health` + `/api/*` routes still work.
