export const CLOUD_DEV_HOST_HEADER = "x-bb-cloud-dev-host";

export interface ConnectRuntime {
  accountAppUrl: string;
  devUserId: string | null;
}

/** Resolve the small, fail-closed set of overrides used by local Cloud. */
export function resolveConnectRuntime(env: {
  ACCOUNT_APP_URL?: string;
  BASE_DOMAIN: string;
  DEV_AUTH_USER_ID?: string;
}): ConnectRuntime {
  const accountAppUrl = new URL(
    env.ACCOUNT_APP_URL?.trim() || `https://${env.BASE_DOMAIN}`,
  );
  if (
    (accountAppUrl.protocol !== "http:" &&
      accountAppUrl.protocol !== "https:") ||
    accountAppUrl.username !== "" ||
    accountAppUrl.password !== "" ||
    accountAppUrl.pathname !== "/" ||
    accountAppUrl.search !== "" ||
    accountAppUrl.hash !== ""
  ) {
    throw new Error("ACCOUNT_APP_URL must be an HTTP(S) origin");
  }

  const devUserId = env.DEV_AUTH_USER_ID?.trim() || null;
  if (devUserId !== null) {
    const isLocalAccount =
      accountAppUrl.protocol === "http:" &&
      (accountAppUrl.hostname === "localhost" ||
        accountAppUrl.hostname === "127.0.0.1");
    if (env.BASE_DOMAIN !== "localhost" || !isLocalAccount) {
      throw new Error(
        "DEV_AUTH_USER_ID is only allowed for local Cloud development",
      );
    }
  }

  return { accountAppUrl: accountAppUrl.origin, devUserId };
}

/** Wrangler replaces wildcard hosts locally; the launcher preserves the label. */
export function resolveConnectRequestHost(
  headers: Headers,
  runtime: ConnectRuntime,
): string {
  const ordinaryHost = headers.get("host") ?? "";
  if (runtime.devUserId === null) return ordinaryHost;
  const label = headers.get(CLOUD_DEV_HOST_HEADER)?.trim().toLowerCase();
  if (!label || label.includes(".") || !/^[a-z0-9-]+$/u.test(label)) {
    return ordinaryHost;
  }
  return `${label}.localhost`;
}

export function stripCloudDevHeader(headers: Headers): void {
  headers.delete(CLOUD_DEV_HOST_HEADER);
}
