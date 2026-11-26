# backend

A free-model LLM gateway with **no accounts and no provider keys**, plus the
original keyed fallback gateway and a Supabase proxy.

Everything below runs on **one port** (`PORT`, default `3000`). `/` is the phone
dashboard; the APIs are behind it.

```
phone  ──►  https://<your-host>/                   dashboard: status, base URL,
                                                   key with copy buttons, model
                                                   list, streaming "try it"
        ──►  https://<your-host>/ofm/v1/*          free models, bearer key
        ──►  https://<your-host>/v1/*              your own provider keys
```

## Quick start

```bash
npm ci                  # also fetches the our-free-model service into ./vendor
PORT=3000 npm start
```

Open `http://<host>:3000/` and use the base URL + key it shows.

| Route | Auth | What |
| --- | --- | --- |
| `/` | none | phone dashboard (`?json=1` returns the route index) |
| `/api/state`, `/api/test` | none, same-origin | dashboard data + one streamed turn |
| `/ofm/v1/models` | `Bearer <ofm key>` | free model roster |
| `/ofm/v1/chat/completions` | `Bearer <ofm key>` | chat, stream + non-stream |
| `/ofm/v1/responses`, `/ofm/v1/messages` | `Bearer <ofm key>` | other OpenAI/Anthropic shapes |
| `/v1/*` | `Bearer $GATEWAY_TOKEN` | keyed fallback across Gemini/Groq/… |
| `/setup` | none | phone copy-paste card |
| `/health` | none | status of both processes |

## Where the free models come from

`vendor/dsh-our-free-model` is [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)'s
standalone service, fetched at install time by `scripts/ofm-fetch.mjs` (it is not
committed: upstream carries its own Google OAuth credentials, which push
protection refuses to accept here). It runs as a child process on
`127.0.0.1:18900`, and only its **inference** paths are proxied — its console is
loopback-only upstream and stays that way; see [PHONE.md](PHONE.md).

`bun` is required by the free lane's transport. It is installed in the
`Dockerfile`; for a bare-metal run, `npm i -g bun` or set `OUR_FREE_MODEL_BUN`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | the one public port |
| `OFM_PORT` | `18900` | loopback port of the free-model service |
| `OFM_HOME` | `./.ofm` (`/data/ofm` in Docker) | its data dir — **keep this**, it holds the key |
| `OFM_ENABLED` | `1` | `0` disables the free-model service |
| `GATEWAY_TOKEN` | — | enables the keyed `/v1` gateway |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | — | enables `/api/items` |

## Deploy

`Dockerfile` is the supported path (bun + a `/data` volume for `OFM_HOME`):

```bash
docker build -t free-model .
docker run -p 3000:3000 -v ofm:/data free-model
```

On Railway: new service from this repo, builder **Dockerfile**, mount a volume at
`/data`, then generate a domain. Keep the volume: the phone's key lives in it.

## Tests

```bash
npm test        # 26 tests, all offline, no quota spent
```
