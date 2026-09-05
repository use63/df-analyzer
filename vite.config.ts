import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as {
  name: string;
  version: string;
};

if (!packageJson.version || typeof packageJson.version !== 'string') {
  throw new Error('package.json version is required for build');
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Deepfake Image Analyzer',
        short_name: 'DF-Analyzer',
        description: 'Forensic deepfake image analysis and digital verification tool',
        theme_color: '#0b0b0d',
        background_color: '#0b0b0d',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/analyze': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/chat': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/history': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
    },
  },
});
