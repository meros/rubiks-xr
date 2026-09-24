import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 npm run dev serves a self-signed certificate, for a Quest on the LAN.
// Over USB, `adb reverse tcp:5173 tcp:5173` and plain http://localhost:5173 is enough.
export default defineConfig({
  // GitHub Pages serves the site under /rubiks-xr/; the workflow sets BASE.
  base: process.env.BASE ?? '/',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: { port: 5173 },
  build: { target: 'es2022' },
});
