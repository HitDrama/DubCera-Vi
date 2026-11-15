import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DubCera — AI Vietnamese Video Dubbing',
    description: 'Every word. Perfectly synced. Synchronized Vietnamese dubbing & 1-2 line subtitles for lectures and tutorials.',
    version: '0.2.0',
    permissions: ['storage'],
    host_permissions: [
      'http://127.0.0.1:8765/*',
      'https://translate.googleapis.com/*',
      'https://generativelanguage.googleapis.com/*',
      'https://api.groq.com/*',
      'https://api.openai.com/*',
      'https://api.deepseek.com/*',
      'https://openrouter.ai/*',
      'https://*.youtube.com/*',
      'https://*.udemy.com/*',
      'https://*.udemycdn.com/*',
    ],
  },
});
