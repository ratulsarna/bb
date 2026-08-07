import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const cloudDevStatePath = process.env.BB_CLOUD_DEV_STATE_PATH?.trim();
const cloudDevAppUrl = process.env.BB_CLOUD_DEV_APP_URL?.trim();
const cloudDevServerUrlTemplate =
  process.env.BB_CLOUD_DEV_SERVER_URL_TEMPLATE?.trim();
const cloudDevAuthUserId = process.env.BB_CLOUD_DEV_AUTH_USER_ID?.trim();

const cloudDevConfig =
  cloudDevStatePath &&
  cloudDevAppUrl &&
  cloudDevServerUrlTemplate &&
  cloudDevAuthUserId
    ? {
        persistState: { path: cloudDevStatePath },
        config: (config: { vars?: Record<string, unknown> }) => ({
          vars: {
            ...config.vars,
            APP_URL: cloudDevAppUrl,
            BASE_DOMAIN: "localhost",
            BETTER_AUTH_SECRET: "bb-local-cloud-development",
            CONNECT_SERVER_URL_TEMPLATE: cloudDevServerUrlTemplate,
            DEV_AUTH_USER_ID: cloudDevAuthUserId,
            GITHUB_CLIENT_ID: "local-cloud-dev-unused",
            GITHUB_CLIENT_SECRET: "local-cloud-dev-unused",
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
    allowedHosts: [".localhost", ".ts.net"],
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" }, ...cloudDevConfig }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
