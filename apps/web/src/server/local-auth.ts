import type { Env } from "./env.js";

/** Return the seeded local identity, rejecting any attempt to deploy it. */
export function resolveLocalDevUserId(
  env: Pick<Env, "APP_URL" | "BASE_DOMAIN" | "DEV_AUTH_USER_ID">,
): string | null {
  const userId = env.DEV_AUTH_USER_ID?.trim();
  if (!userId) return null;

  const appUrl = new URL(env.APP_URL);
  const isLoopback =
    appUrl.protocol === "http:" &&
    (appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1");
  if (env.BASE_DOMAIN !== "localhost" || !isLoopback) {
    throw new Error(
      "DEV_AUTH_USER_ID is only allowed for local Cloud development",
    );
  }
  return userId;
}
