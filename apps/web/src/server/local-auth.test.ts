import { describe, expect, it } from "vitest";
import { resolveLocalDevUserId } from "./local-auth.js";

describe("resolveLocalDevUserId", () => {
  it("allows the seeded identity only on the local Cloud origin", () => {
    expect(
      resolveLocalDevUserId({
        APP_URL: "http://localhost:8787",
        BASE_DOMAIN: "localhost",
        DEV_AUTH_USER_ID: "usr_cloud_dev",
      }),
    ).toBe("usr_cloud_dev");

    expect(() =>
      resolveLocalDevUserId({
        APP_URL: "https://getbb.app",
        BASE_DOMAIN: "getbb.app",
        DEV_AUTH_USER_ID: "usr_cloud_dev",
      }),
    ).toThrow("only allowed for local Cloud development");
  });
});
