import { describe, expect, it } from "vitest";
import {
  LOCAL_BETTER_AUTH_SESSION_COOKIE,
  SECURE_BETTER_AUTH_SESSION_COOKIE,
  resolveBetterAuthSessionCookieName,
  resolveConnectAuthRuntime,
  resolveConnectRequestHost,
  stripConnectDevRoutingHeaders,
} from "./auth-cookie.js";

describe("Better Auth session cookie configuration", () => {
  it("defaults to the production HTTPS cookie", () => {
    expect(resolveBetterAuthSessionCookieName(undefined)).toBe(
      SECURE_BETTER_AUTH_SESSION_COOKIE,
    );
  });

  it("accepts the explicit loopback HTTP cookie", () => {
    expect(
      resolveBetterAuthSessionCookieName(LOCAL_BETTER_AUTH_SESSION_COOKIE),
    ).toBe(LOCAL_BETTER_AUTH_SESSION_COOKIE);
  });

  it("rejects arbitrary cookie names", () => {
    expect(() => resolveBetterAuthSessionCookieName("attacker-cookie")).toThrow(
      /supported Better Auth session cookie/u,
    );
  });
});

describe("Connect auth runtime", () => {
  it("defaults production to the HTTPS account apex", () => {
    expect(resolveConnectAuthRuntime({ BASE_DOMAIN: "getbb.app" })).toEqual({
      accountAppUrl: "https://getbb.app",
      devAuthUserId: null,
    });
  });

  it("allows the seeded identity only on the local split-service topology", () => {
    expect(
      resolveConnectAuthRuntime({
        BASE_DOMAIN: "localhost",
        ACCOUNT_APP_URL: "http://127.0.0.1:8792",
        DEV_AUTH_USER_ID: "usr_cloud_dev",
      }),
    ).toEqual({
      accountAppUrl: "http://127.0.0.1:8792",
      devAuthUserId: "usr_cloud_dev",
    });
  });

  it("rejects a seeded identity on deployed domains", () => {
    expect(() =>
      resolveConnectAuthRuntime({
        BASE_DOMAIN: "getbb.app",
        ACCOUNT_APP_URL: "https://getbb.app",
        DEV_AUTH_USER_ID: "usr_cloud_dev",
      }),
    ).toThrow("only allowed for a localhost gate");
  });
});

describe("local routing host", () => {
  it("accepts a proxy-preserved host only with the per-run token", () => {
    const headers = new Headers({
      host: "getbb.app",
      "x-bb-cloud-dev-routing-label": "sawyer",
      "x-bb-cloud-dev-token": "secret",
    });
    expect(
      resolveConnectRequestHost(headers, {
        BASE_DOMAIN: "localhost",
        DEV_ROUTING_TOKEN: "secret",
      }),
    ).toBe("sawyer.localhost");
    expect(
      resolveConnectRequestHost(headers, {
        BASE_DOMAIN: "localhost",
        DEV_ROUTING_TOKEN: "different",
      }),
    ).toBe("getbb.app");
  });

  it("strips local routing headers before origin forwarding", () => {
    const headers = new Headers({
      "x-bb-cloud-dev-routing-label": "sawyer",
      "x-bb-cloud-dev-token": "secret",
    });
    stripConnectDevRoutingHeaders(headers);
    expect([...headers]).toEqual([]);
  });
});
