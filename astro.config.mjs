// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// Astro app-shell config.
// - React is loaded ONLY as interactive islands (no global hydration / no SPA).
// - `server.host` lets the dev server bind on the Tailscale interface so the app
//   is reachable at https://<tailscale-host>.ts.net during testing.
export default defineConfig({
  integrations: [react()],
  server: {
    host: true,
    port: 4321,
  },
  vite: {
    server: {
      // Allow the Tailscale MagicDNS hostname (and any *.ts.net) through Vite's
      // dev-server host check.
      allowedHosts: [".ts.net"],
    },
    preview: {
      // Tailscale Serve terminates TLS and forwards Host: *.ts.net.
      allowedHosts: true,
    },
    build: {
      // The lessons island intentionally bundles the static fuzzy-funicular deck.
      // It is ~185 kB gzip and acceptable for this Tailnet-first learning app.
      chunkSizeWarningLimit: 1000,
    },
  },
});
