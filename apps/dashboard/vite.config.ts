import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app/',
  server: { proxy: { '/api': api, '/clip': api, '/pause': api, '/resume': api, '/proposals': api, '/proposal-frame': api, '/toggle': api } },
});
