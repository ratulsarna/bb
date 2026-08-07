export const SECURE_BETTER_AUTH_SESSION_COOKIE =
  "__Secure-better-auth.session_token";
export const LOCAL_BETTER_AUTH_SESSION_COOKIE = "better-auth.session_token";

/**
 * Production defaults to Better Auth's HTTPS cookie. The local Cloud launcher
 * explicitly selects the HTTP cookie name emitted for its loopback APP_URL.
 */
export function resolveBetterAuthSessionCookieName(
  configuredName: string | undefined,
): string {
  if (configuredName === undefined) return SECURE_BETTER_AUTH_SESSION_COOKIE;
  if (
    configuredName === SECURE_BETTER_AUTH_SESSION_COOKIE ||
    configuredName === LOCAL_BETTER_AUTH_SESSION_COOKIE
  ) {
    return configuredName;
  }
  throw new Error(
    "BETTER_AUTH_SESSION_COOKIE_NAME must name a supported Better Auth session cookie",
  );
}

export interface ConnectAuthRuntime {
  accountAppUrl: string;
  devAuthUserId: string | null;
}

const DEV_ROUTING_LABEL_HEADER = "x-bb-cloud-dev-routing-label";
const DEV_ROUTING_TOKEN_HEADER = "x-bb-cloud-dev-token";

/**
 * Resolve the gate's account origin and tightly-scoped local auth bypass once
 * at the Worker boundary. A seeded identity can never be enabled for a
 * deployed domain or a non-loopback account origin.
 */
export function resolveConnectAuthRuntime(env: {
  BASE_DOMAIN: string;
  ACCOUNT_APP_URL?: string;
  DEV_AUTH_USER_ID?: string;
}): ConnectAuthRuntime {
  const configuredAppUrl = env.ACCOUNT_APP_URL?.trim();
  const accountUrl = new URL(configuredAppUrl || `https://${env.BASE_DOMAIN}`);
  if (
    (accountUrl.protocol !== "http:" && accountUrl.protocol !== "https:") ||
    accountUrl.username !== "" ||
    accountUrl.password !== "" ||
    accountUrl.pathname !== "/" ||
    accountUrl.search !== "" ||
    accountUrl.hash !== ""
  ) {
    throw new Error("ACCOUNT_APP_URL must be an HTTP(S) origin");
  }

  const configuredUserId = env.DEV_AUTH_USER_ID?.trim();
  if (!configuredUserId) {
    return { accountAppUrl: accountUrl.origin, devAuthUserId: null };
  }
  const loopbackAccount =
    accountUrl.protocol === "http:" &&
    (accountUrl.hostname === "127.0.0.1" ||
      accountUrl.hostname === "localhost" ||
      accountUrl.hostname === "::1");
  if (env.BASE_DOMAIN !== "localhost" || !loopbackAccount) {
    throw new Error(
      "DEV_AUTH_USER_ID is only allowed for a localhost gate and loopback account origin",
    );
  }
  return {
    accountAppUrl: accountUrl.origin,
    devAuthUserId: configuredUserId,
  };
}

/**
 * Wrangler rewrites local request hosts to one configured upstream. The
 * launcher-owned loopback proxy preserves the browser host behind a per-run
 * token; deployed requests always use the ordinary Host header.
 */
export function resolveConnectRequestHost(
  headers: Headers,
  env: {
    BASE_DOMAIN: string;
    DEV_ROUTING_TOKEN?: string;
  },
): string {
  const ordinaryHost = headers.get("host") ?? "";
  const configuredToken = env.DEV_ROUTING_TOKEN?.trim();
  if (!configuredToken) return ordinaryHost;
  if (env.BASE_DOMAIN !== "localhost") {
    throw new Error("DEV_ROUTING_TOKEN is only allowed for the localhost gate");
  }
  if (headers.get(DEV_ROUTING_TOKEN_HEADER) !== configuredToken) {
    return ordinaryHost;
  }
  const routingLabel = headers.get(DEV_ROUTING_LABEL_HEADER);
  return routingLabel ? `${routingLabel}.${env.BASE_DOMAIN}` : ordinaryHost;
}

/** Never expose launcher-only routing proof to a tunneled bb origin. */
export function stripConnectDevRoutingHeaders(headers: Headers): void {
  headers.delete(DEV_ROUTING_LABEL_HEADER);
  headers.delete(DEV_ROUTING_TOKEN_HEADER);
}
