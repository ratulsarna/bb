// Redeem a one-time connect code against the connect cloud for a durable
// tunnel credential. Ported from the kernel's services/connect/redeem.ts.
import { z } from "zod";

export const DEFAULT_CONNECT_BASE_URL = "https://getbb.app";
export const CONNECT_BASE_URL_ENV_NAME = "BB_CONNECT_BASE_URL";
export const CONNECT_LOOPBACK_URL_ENV_NAME = "BB_CONNECT_LOOPBACK_URL";

/** Read the optional Cloud account/redeem origin at the point of use. */
export function resolveConnectBaseUrlOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[CONNECT_BASE_URL_ENV_NAME]?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${CONNECT_BASE_URL_ENV_NAME} must be a valid URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${CONNECT_BASE_URL_ENV_NAME} must be an HTTP(S) origin`);
  }
  return url.origin;
}

/**
 * Source-development override for the local origin served through the tunnel.
 * It is intentionally loopback-only: allowing arbitrary origins would turn a
 * pairing into an ambient HTTP relay to another machine.
 */
export function resolveConnectLoopbackUrlOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[CONNECT_LOOPBACK_URL_ENV_NAME]?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${CONNECT_LOOPBACK_URL_ENV_NAME} must be a valid URL`);
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !isLoopback ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${CONNECT_LOOPBACK_URL_ENV_NAME} must be a loopback HTTP origin`,
    );
  }
  return url.origin;
}

export interface RedeemedCredential {
  credential: string;
  /**
   * Routing label of the redeemed server (its subdomain). Equal to the
   * account handle for the primary server; a distinct label when pairing an
   * additional bb. Used to build serverUrl and share URLs — not necessarily
   * the account's primary handle.
   */
  handle: string;
  /**
   * Gate origin chosen by Cloud. Older deployed redeem endpoints omit it, in
   * which case the client retains the legacy handle + base URL derivation.
   */
  serverUrl?: string;
}

const httpOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected an HTTP(S) origin",
      });
      return z.NEVER;
    }
    return url.origin;
  });

const redeemedCredentialSchema = z.object({
  credential: z.string().min(1),
  handle: z.string().min(1),
  serverUrl: httpOriginSchema.optional(),
});

const redeemErrorSchema = z.object({ error: z.string().optional() });

/**
 * Typed pairing failure. `code` is the stable, UI-facing reason (mapped to
 * human copy by the panel); `message` keeps the raw wire detail for the CLI
 * and the plugin log — never shown verbatim in the panel.
 */
export type ConnectPairErrorCode =
  | "invalid_code"
  | "expired_code"
  | "already_used"
  | "network";

export class ConnectPairError extends Error {
  constructor(
    readonly code: ConnectPairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectPairError";
  }
}

/** Map an HTTP redeem rejection (status + optional wire error) to a code. */
function pairErrorCodeForRedeem(
  status: number,
  wireError: string | undefined,
): ConnectPairErrorCode {
  const detail = (wireError ?? "").toLowerCase();
  if (detail.includes("expired") || status === 410) return "expired_code";
  if (
    detail.includes("already") ||
    detail.includes("used") ||
    detail.includes("redeemed") ||
    status === 409
  ) {
    return "already_used";
  }
  if (status >= 500) return "network";
  return "invalid_code";
}

/** Normalize any thrown value from a pair attempt into a ConnectPairError. */
export function asConnectPairError(error: unknown): ConnectPairError {
  if (error instanceof ConnectPairError) return error;
  // fetch() rejects (DNS/refused/reset/offline) with a TypeError — transport,
  // not a bad code.
  const message = error instanceof Error ? error.message : String(error);
  return new ConnectPairError("network", message);
}

export async function redeemConnectCode(args: {
  code: string;
  baseUrl: string;
}): Promise<RedeemedCredential> {
  const res = await fetch(`${args.baseUrl}/api/connect/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: args.code }),
  });
  if (!res.ok) {
    const parsedError = redeemErrorSchema.safeParse(
      await res.json().catch(() => ({})),
    );
    const wireError = parsedError.success ? parsedError.data.error : undefined;
    throw new ConnectPairError(
      pairErrorCodeForRedeem(res.status, wireError),
      `Redeem failed (${res.status})${wireError ? `: ${wireError}` : ""}`,
    );
  }
  const parsed = redeemedCredentialSchema.safeParse(
    await res.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new ConnectPairError(
      "network",
      `Redeem returned an invalid response: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
