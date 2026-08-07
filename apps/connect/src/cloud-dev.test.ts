import { describe, expect, it } from "vitest";
import {
  CLOUD_DEV_HOST_HEADER,
  resolveConnectRequestHost,
  resolveConnectRuntime,
} from "./cloud-dev.js";

describe("local Cloud request routing", () => {
  it("accepts the launcher host only with a local seeded identity", () => {
    const runtime = resolveConnectRuntime({
      ACCOUNT_APP_URL: "http://localhost:8787",
      BASE_DOMAIN: "localhost",
      DEV_AUTH_USER_ID: "usr_cloud_dev",
    });
    const headers = new Headers({
      host: "localhost",
      [CLOUD_DEV_HOST_HEADER]: "sawyer--3000",
    });
    expect(resolveConnectRequestHost(headers, runtime)).toBe(
      "sawyer--3000.localhost",
    );
  });

  it("ignores the launcher header in production", () => {
    const runtime = resolveConnectRuntime({ BASE_DOMAIN: "getbb.app" });
    const headers = new Headers({
      host: "sawyer.getbb.app",
      [CLOUD_DEV_HOST_HEADER]: "attacker",
    });
    expect(resolveConnectRequestHost(headers, runtime)).toBe(
      "sawyer.getbb.app",
    );
  });

  it("rejects a deployed auth bypass", () => {
    expect(() =>
      resolveConnectRuntime({
        ACCOUNT_APP_URL: "https://getbb.app",
        BASE_DOMAIN: "getbb.app",
        DEV_AUTH_USER_ID: "usr_cloud_dev",
      }),
    ).toThrow("only allowed for local Cloud development");
  });
});
