import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DubCera — AI Vietnamese Video Dubbing',
    description: 'Every word. Perfectly synced. Synchronized Vietnamese dubbing & 1-2 line subtitles for lectures and tutorials.',
    version: '0.1.0',
    permissions: ['storage'],
    host_permissions: [
      'http://127.0.0.1:8765/*',
      'https://translate.googleapis.com/*',
      'https://*.youtube.com/*',
      'https://*.udemy.com/*',
      'https://*.udemycdn.com/*',
    ],
  },
});
