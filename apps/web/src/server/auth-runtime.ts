import type { Env } from "./env.js";

const LOOPBACK_IPV4_PREFIX = "127.";

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (!normalized.startsWith(LOOPBACK_IPV4_PREFIX)) return false;

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/u.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

function appUrl(env: Pick<Env, "APP_URL">): URL {
  try {
    return new URL(env.APP_URL);
  } catch {
    throw new Error("APP_URL must be an absolute URL");
  }
}

/**
 * The launcher may opt into a seeded account, but only for a loopback web app.
 * Throwing on a non-loopback origin makes an accidental production binding
 * fail closed instead of silently bypassing Better Auth.
 */
export function resolveDevAuthUserId(
  env: Pick<Env, "APP_URL" | "DEV_AUTH_USER_ID">,
): string | null {
  if (env.DEV_AUTH_USER_ID === undefined) return null;

  const userId = env.DEV_AUTH_USER_ID.trim();
  if (userId.length === 0) {
    throw new Error("DEV_AUTH_USER_ID must be a non-empty user id");
  }

  const url = appUrl(env);
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "DEV_AUTH_USER_ID is only allowed when APP_URL is an HTTP loopback origin",
    );
  }
  return userId;
}

/**
 * Production/staging share the Better Auth session with label subdomains.
 * Loopback and preview origins instead receive a host-only cookie; a Domain
 * attribute for `.getbb.app` would be rejected by a browser on 127.0.0.1.
 */
export function crossSubdomainCookieConfig(
  env: Pick<Env, "APP_URL" | "BASE_DOMAIN">,
): { enabled: false } | { enabled: true; domain: string } {
  const url = appUrl(env);
  const hostname = normalizeHostname(url.hostname);
  const baseDomain = normalizeHostname(env.BASE_DOMAIN).replace(/^\./u, "");
  if (baseDomain.length === 0) {
    throw new Error("BASE_DOMAIN must be a non-empty hostname");
  }

  const belongsToBaseDomain =
    hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
  return belongsToBaseDomain
    ? { enabled: true, domain: `.${baseDomain}` }
    : { enabled: false };
}
