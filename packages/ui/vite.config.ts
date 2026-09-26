// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev the UI runs on Vite (5173) and proxies API + WebSocket traffic to the
// core daemon (8723). In production the core serves the built UI itself, so no
// proxy is needed and the client uses same-origin relative URLs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Must mirror tsconfig.json's "@/*" path exactly. The shadcn CLI bakes
    // `@/lib/cn` into every component it writes, so a mismatch between these
    // two is a clean typecheck and a broken bundle (or the reverse).
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/trpc': { target: 'http://localhost:8723', changeOrigin: true, ws: true },
      '/api': { target: 'http://localhost:8723', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Group stable, rarely-changing vendors into their own cacheable chunks
        // so an app-code change doesn't bust the whole vendor download.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['motion'],
          // The shadcn primitives' shared machinery — focus scope, dismissable
          // layer, presence, portal, roving focus. It is ~44 kB gzipped and it
          // changes only when a primitive is added, so keeping it out of the
          // entry chunk stops every app-code edit re-downloading it. Tree
          // shaking does work here (Accordion, Slider, Tabs, Tooltip, Popover
          // and Toast are all absent from the build) — this is what the five
          // primitives we DO use actually cost.
          radix: ['radix-ui'],
          query: ['@trpc/client', '@trpc/server', '@trpc/react-query', '@tanstack/react-query'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
  },
});
