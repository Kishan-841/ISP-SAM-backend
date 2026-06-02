import type { Request } from 'express';

/**
 * Single source of truth for extracting client metadata (IP + user agent)
 * from an Express request. Used by audit-log writers so every action
 * captures the same shape of forensic data.
 *
 * IP extraction precedence:
 *   1. `X-Forwarded-For` first hop  — set by nginx / Caddy / Cloudflare
 *      when running behind a reverse proxy. Requires `app.set('trust proxy', ...)`
 *      for Express to populate `req.ips` correctly.
 *   2. `req.ip` — Express's best guess (also honours `trust proxy`).
 *   3. `req.socket.remoteAddress` — raw socket fallback.
 *
 * IPv6-mapped IPv4 addresses (`::ffff:1.2.3.4`) are normalised to plain v4.
 */
export type RequestContext = {
  ip: string | null;
  userAgent: string | null;
};

function normalise(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  // `::ffff:1.2.3.4` → `1.2.3.4`
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped) return mapped[1]!;
  return trimmed;
}

export function getRequestContext(req: Request): RequestContext {
  const xff = req.headers['x-forwarded-for'];
  const firstHop =
    typeof xff === 'string'
      ? xff.split(',')[0]
      : Array.isArray(xff) && xff[0]
        ? xff[0]
        : null;
  const ip =
    normalise(firstHop) ??
    normalise(req.ip) ??
    normalise(req.socket?.remoteAddress) ??
    null;

  const ua = req.headers['user-agent'];
  const userAgent = typeof ua === 'string' && ua.trim() ? ua.trim().slice(0, 1024) : null;

  return { ip, userAgent };
}
