import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
