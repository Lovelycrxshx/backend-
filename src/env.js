// Works on Node (process.env) and on Cloudflare Workers (c.env bindings).
export const env = (c, k) => c?.env?.[k] ?? (typeof process !== 'undefined' ? process.env?.[k] : undefined);

// Constant-time-ish string compare so the gateway token isn't leakable by timing.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
