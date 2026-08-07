import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const cloudDevStatePath = process.env.BB_CLOUD_DEV_STATE_PATH?.trim();
const cloudDevAppUrl = process.env.BB_CLOUD_DEV_APP_URL?.trim();
const cloudDevBaseDomain = process.env.BB_CLOUD_DEV_BASE_DOMAIN?.trim();
const cloudDevConnectServerUrlTemplate =
  process.env.BB_CLOUD_DEV_CONNECT_SERVER_URL_TEMPLATE?.trim();
const cloudDevAuthUserId = process.env.DEV_AUTH_USER_ID?.trim();

const cloudDevConfig =
  cloudDevStatePath &&
  cloudDevAppUrl &&
  cloudDevBaseDomain &&
  cloudDevConnectServerUrlTemplate
    ? {
        persistState: { path: cloudDevStatePath },
        config: (config: { vars?: Record<string, unknown> }) => ({
          vars: {
            ...config.vars,
            APP_URL: cloudDevAppUrl,
            BASE_DOMAIN: cloudDevBaseDomain,
            CONNECT_SERVER_URL_TEMPLATE: cloudDevConnectServerUrlTemplate,
            ...(cloudDevAuthUserId
              ? { DEV_AUTH_USER_ID: cloudDevAuthUserId }
              : {}),
          },
        }),
      }
    : {};

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Dev binds all interfaces so the server is reachable over the tailnet
  // (see the dev script's --host 0.0.0.0); allow Tailscale MagicDNS names.
  server: {
    allowedHosts: [".ts.net"],
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...cloudDevConfig,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
