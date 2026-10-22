import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script', // external registerSW.js keeps the CSP free of inline scripts
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Tally',
        short_name: 'Tally',
        description: 'Budgets, spending and net worth in one place.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0c10',
        theme_color: '#0b0c10',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Transactions', url: '/transactions', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Budgets', url: '/budgets', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // Financial data is never cached by the service worker; only the app shell is.
        runtimeCaching: [],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:3997' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
