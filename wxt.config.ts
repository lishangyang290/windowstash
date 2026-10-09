import { defineConfig } from 'wxt';
import { resolve } from 'node:path';
import { generateExtensionGuide } from './scripts/generate-extension-guide';

function supabaseHostPermissions(): string[] {
  const value = process.env.VITE_SUPABASE_URL?.trim();
  if (!value) return [];
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') ? [`${url.origin}/*`] : [];
  } catch {
    return [];
  }
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: ({ mode }) => ({
    name: 'WindowStash',
    description: '以工作任务为单位保存、关闭并恢复 Chrome 窗口。',
    permissions: ['tabs', 'storage', 'alarms', 'favicon'],
    host_permissions: mode === 'development' ? supabaseHostPermissions() : [],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  }),
  hooks: {
    'build:done': (wxt) => generateExtensionGuide(
      resolve(wxt.config.publicDir, '开始使用.html'),
      wxt.config.outDir,
    ),
  },
});
