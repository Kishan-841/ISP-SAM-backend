import type { Request } from 'express';

/**
 * Single source of truth for extracting client metadata (IP + user agent)
 * from an Express request. Used by audit-log writers so every action
 * captures the same shape of forensic data.
 *
 * IP extraction:
 *   - Use `req.ip` only. Express has already evaluated the `trust proxy`
 *     setting (configured in server.ts as 'loopback, linklocal,
 *     uniquelocal') and decided whether to honour `X-Forwarded-For`. If
 *     the request came in directly from the internet, Express ignores
 *     XFF and gives us the real socket address — preventing an attacker
 *     from spoofing the audit log by setting their own XFF header.
 *   - Fall back to `req.socket.remoteAddress` only when `req.ip` is
 *     unavailable (e.g. test stubs that don't populate it).
 *
 * Do NOT manually parse `req.headers['x-forwarded-for']` here — that
 * would bypass Express's trust-proxy gate and allow direct-to-server
 * clients to inject arbitrary IPs into audit logs.
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
  const ip = normalise(req.ip) ?? normalise(req.socket?.remoteAddress) ?? null;

  const ua = req.headers['user-agent'];
  const userAgent = typeof ua === 'string' && ua.trim() ? ua.trim().slice(0, 1024) : null;

  return { ip, userAgent };
}
