# Run it on your phone

Two services run in this repo now:

| Process | Binds | What it is |
| --- | --- | --- |
| `node src/index.js` (Hono) | `0.0.0.0:$PORT` | public gateway: `/setup`, `/v1/*` (own keys), `/ofm/v1/*` (no keys needed) |
| `vendor/dsh-our-free-model/.../cli.mjs` | `127.0.0.1:18900` | the our-free-model standalone service, spawned automatically |

## The phone

1. Open `https://<your-host>/setup` **on the phone**.
2. Copy **`https://<your-host>/ofm/v1`** and the key shown under *Our Free Model*
   into any OpenAI-compatible app:
   - **ChatterUI** → API → Create Connection → Type `Generic` → **Chat Completions**
     → Endpoint `https://<your-host>/ofm/v1`, API key = the `ofm-…` key,
     Model = any id listed on `/setup`.
   - **Chatbox** → Add Custom Provider → **OpenAI API Compatible** →
     API Host `https://<your-host>/ofm/v1`, key = same.
3. The key is the standalone service's own `forwardKey`, read from
   `OFM_HOME/settings.json` (default `./.ofm`, Docker `/data/ofm`). It is stable
   across restarts as long as that directory survives.

## What is deliberately *not* on the public URL

The our-free-model **console** (`/`, `/assets/*`, `/api/management/*`) is
loopback-only upstream: it validates a loopback `Host` header, refuses
cross-origin callers, and mints its session from a one-time `#login=` link via an
HttpOnly `SameSite=Strict` cookie. Publishing it would mean overriding three
independent guards and would put account-channel credentials behind a single
bearer key. So `/ofm` forwards **inference paths only**:

```
GET  /ofm/v1/models
POST /ofm/v1/chat/completions     (stream + non-stream)
POST /ofm/v1/responses
POST /ofm/v1/messages             (+ /v1/messages/count_tokens)
GET  /ofm/v1/health
```

Everything else under `/ofm` is `404`. To use the console, open it from the
machine running the server: the child prints its one-time link on stdout at
startup (`管理页面 … http://127.0.0.1:18900/#login=…`). `GET /health` reports
`ofm.dataDir` and whether the key is written.

## Local run

```bash
npm ci
npm test                        # 21 tests, all offline
PORT=3000 npm start
# phone on the same Wi-Fi: http://<your-laptop-ip>:3000/setup
```

`PORT` is public; `OFM_PORT` (default `18900`) and `OFM_HOME` (default `./.ofm`)
control the child. `OFM_ENABLED=0` skips it and leaves the keyed gateway only.

## Deploy

`Dockerfile` installs **Bun** — the our-free-model free lane's default transport
needs it (`TRANSPORT` error otherwise) — and puts the data directory on a volume
at `/data`, so the `ofm-…` key in your phone stays valid across deploys.
`railway.json` still builds with Nixpacks; if you want the Docker image instead,
set the service builder to **Dockerfile**.

## Why a request can still fail from inside a sandbox

The free upstreams (`opencode.ai`, `kilo.ai`) have to be reachable from wherever
the server runs. In an egress-restricted sandbox they are not, and every model
answers `upstream request failed` / `ERR_TRANSPORT` — that is the network, not
the code. `GET /ofm/v1/health` tells you the service is up; the model test in the
console tells you which models your network exit can actually reach.

## The URL that was 502 ("Sandbox not found")

That page is the sandbox host, not this app: the preview URL dies whenever the
sandbox is paused or recycled, and an idle sandbox is recycled routinely. Two
ways to keep a URL your phone can open:

**A. Keep this one awake, then reopen it.** The port is `8080` (dashboard) —
reopening it in the browser wakes the sandbox and the preview rebinds. If the
sandbox was fully recycled, its id is gone and the old URL cannot be revived;
start the preview again from this session to get the new host.

**B. Deploy it somewhere that stays up.** `Dockerfile` is the durable answer:
`docker run -p 3000:3000 -p 8080:8080 -v ofm:/data <image>`, or Railway with the
Dockerfile builder. Then the URL is yours and does not depend on a session.

## Dashboard (port 8080)

`node dashboard/server.js` (or `./scripts/dev.sh`) serves one phone-sized page:

- status of both processes, bun, key and model count;
- the exact base URL + key with copy buttons, sized for pasting into ChatterUI;
- the live model list, tap to select;
- a **Try it** box that streams a real chat turn (reasoning + answer, first-word
  latency) — it posts to the same origin, so no CORS and no typing keys on a
  phone keyboard.

It is a *separate* listener from `src/index.js` on purpose: the browser only ever
talks to port 8080, and it reaches the gateway on `127.0.0.1:3000` and the
our-free-model service on `127.0.0.1:18900` server-side.
