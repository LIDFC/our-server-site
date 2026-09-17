import { defineConfig } from "astro/config";

const backend = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? "https://mc.vin-off.site",
  output: "static",
  trailingSlash: "ignore",
  compressHTML: true,
  devToolbar: { enabled: false },
  build: {
    // everything is loaded from files, so the Content-Security-Policy can forbid inline scripts
    inlineStylesheets: "never",
  },
  vite: {
    build: { assetsInlineLimit: 0 },
    server: {
      proxy: {
        // changeOrigin stays off so the API sees the Host the browser used and can check the Origin of a POST
        "/api": { target: backend, changeOrigin: false },
        "/media": { target: backend, changeOrigin: false },
      },
    },
  },
});
