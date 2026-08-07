interface BuildDevWebSocketUrlArgs {
  path: string;
}

function resolveBrowserHostDevWebSocketBaseUrl(
  serverPort: number,
  appPort: number,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  // A dev app reached on a port other than Vite's own listener is behind a
  // reverse proxy or bb connect. Its public origin does not expose the
  // backend's local TCP port, so keep the socket on the app origin and let
  // Vite proxy /ws to the server. This covers both HTTPS deployments and the
  // HTTP *.localhost gate used by pnpm cloud:dev.
  if (
    window.location.protocol === "https:" ||
    window.location.port !== String(appPort)
  ) {
    return `${protocol}//${window.location.host}/ws`;
  }

  // Direct sockets remain preferable for ordinary localhost/LAN source dev:
  // they survive backend restarts more reliably than Vite's WS proxy.
  return `${protocol}//${window.location.hostname}:${serverPort}/ws`;
}

function resolveDevWebSocketBaseUrl(): string | undefined {
  if (
    typeof __BB_DEV_WS_BROWSER_HOST_PORT__ === "number" &&
    typeof __BB_DEV_APP_BROWSER_HOST_PORT__ === "number"
  ) {
    return resolveBrowserHostDevWebSocketBaseUrl(
      __BB_DEV_WS_BROWSER_HOST_PORT__,
      __BB_DEV_APP_BROWSER_HOST_PORT__,
    );
  }

  return undefined;
}

export function buildDevWebSocketUrl(
  args: BuildDevWebSocketUrlArgs,
): string | undefined {
  const baseUrl = resolveDevWebSocketBaseUrl();
  if (baseUrl === undefined) {
    return undefined;
  }

  const url = new URL(baseUrl);
  url.pathname = args.path;
  url.search = "";
  url.hash = "";
  return url.toString();
}
