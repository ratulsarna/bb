import { env as workerEnv } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  TUNNEL_DO: DurableObjectNamespace;
  BASE_DOMAIN: string;
  APP_URL: string;
  /**
   * Loopback-only account override used by the local Cloud launcher. Omitted
   * everywhere that should authenticate through Better Auth.
   */
  DEV_AUTH_USER_ID?: string;
  /**
   * Optional authoritative Connect gate URL template. `{label}` is replaced
   * with the claimed routing label. Production derives the equivalent template
   * from BASE_DOMAIN; local development supplies its worktree-specific port.
   */
  CONNECT_SERVER_URL_TEMPLATE?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  /**
   * Marketing-page endpoints (see src/landing/endpoints.ts). Unset on forks
   * and local dev: /api/subscribe reports signup as not configured, and the
   * download redirect skips server-side click tracking.
   */
  LANDING_POSTHOG_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_AUDIENCE_ID?: string;
}

export function getEnv(): Env {
  return workerEnv as unknown as Env;
}
