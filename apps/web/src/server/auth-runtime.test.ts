import { describe, expect, it } from "vitest";
import {
  crossSubdomainCookieConfig,
  isLoopbackHostname,
  resolveDevAuthUserId,
} from "./auth-runtime.js";

describe("local web authentication", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "[::1]"])(
    "recognizes the loopback hostname %s",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it.each(["getbb.app", "127.0.0.256", "128.0.0.1", "localhost.example"])(
    "rejects the non-loopback hostname %s",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );

  it("returns the seeded user for an HTTP loopback app", () => {
    expect(
      resolveDevAuthUserId({
        APP_URL: "http://127.0.0.1:8792",
        DEV_AUTH_USER_ID: " usr_cloud_dev ",
      }),
    ).toBe("usr_cloud_dev");
  });

  it("uses Better Auth when no seeded user is configured", () => {
    expect(
      resolveDevAuthUserId({
        APP_URL: "https://getbb.app",
      }),
    ).toBeNull();
  });

  it.each([
    "https://getbb.app",
    "https://127.0.0.1:8792",
    "http://dev.getbb.app:8792",
  ])("fails closed when seeded auth is configured for %s", (APP_URL) => {
    expect(() =>
      resolveDevAuthUserId({ APP_URL, DEV_AUTH_USER_ID: "usr_cloud_dev" }),
    ).toThrow(/only allowed/u);
  });
});

describe("Better Auth cookie scope", () => {
  it("shares production cookies with Connect subdomains", () => {
    expect(
      crossSubdomainCookieConfig({
        APP_URL: "https://getbb.app",
        BASE_DOMAIN: "getbb.app",
      }),
    ).toEqual({ enabled: true, domain: ".getbb.app" });
  });

  it("shares staging cookies with its Connect subdomains", () => {
    expect(
      crossSubdomainCookieConfig({
        APP_URL: "https://auth.vibecodethis.site",
        BASE_DOMAIN: "vibecodethis.site",
      }),
    ).toEqual({ enabled: true, domain: ".vibecodethis.site" });
  });

  it("uses a host-only cookie for the local web worker", () => {
    expect(
      crossSubdomainCookieConfig({
        APP_URL: "http://127.0.0.1:8792",
        BASE_DOMAIN: "getbb.app",
      }),
    ).toEqual({ enabled: false });
  });
});
