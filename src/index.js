// Node entrypoint (Railway / local). Cloudflare Workers imports ./app.js directly.
import app from './app.js';

const { serve } = await import('@hono/node-server');
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`listening on 0.0.0.0:${info.port}`);
});
