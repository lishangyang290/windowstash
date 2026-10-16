import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: { __WINDOWSTASH_BUILD_ID__: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) },
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
