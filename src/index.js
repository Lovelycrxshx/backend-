// Node entrypoint (Railway / local). Cloudflare Workers imports ./app.js directly.
import app from './app.js';
import { startOfm, stopOfm } from './ofm.js';

const { serve } = await import('@hono/node-server');
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`listening on 0.0.0.0:${info.port}`);
});

// The vendored our-free-model service runs beside this one on loopback, so the
// onboarding page can show its models and hand the phone a working key. A
// failure to start it must not take the gateway down: the fallback gateway
// above works without it.
startOfm()
  .then((status) => console.log(`our-free-model: ${status.running ? `up on 127.0.0.1:${status.port}` : status.error ?? 'not started'}`))
  .catch((error) => console.warn(`our-free-model: could not start (${error?.message ?? error})`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { stopOfm(); process.exit(0); });
}
