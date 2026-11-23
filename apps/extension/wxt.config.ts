import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DubCera — AI Vietnamese Video Dubbing',
    description: 'Every word. Perfectly synced. Synchronized Vietnamese dubbing & 1-2 line subtitles for lectures and tutorials.',
    version: '0.2.0',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx9QIHhLdwm1sufByrHCpacW/nHrvhUYqgKWhIMY+JgeRjjAt1vTFLK7kxBrq5jvCiUEWPPILpP99wOzay+7eK8hREKZnU4I6SlF72k5UgRgsimIsnx85cpQFAGW3TAQp4Nnb4NBuo32cyKhr5p6CINTY8l7qBiaZdWvl0bvnxsPKTahdvThfWQxuRrZ0yVuJLXnz4tklz0ISBWyMqgwDtSntOOIvJsL7kuONIeiV1B1anam5mV6yh2eg/yPjnSfipkq3vUy96n7VUkSU2JIktcQ6e6m6JcfSYVi2/8u7cHdPvF4bOxWVKJRgJk/tLh1tetuKaq8P2LnfRP9/MAYAnwIDAQAB',
    permissions: ['storage', 'nativeMessaging'],
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
      'https://fasttracktutorials.com/*',
      'https://*.fasttracktutorials.com/*',
      'https://iframe.mediadelivery.net/*',
      'https://*.b-cdn.net/*',
    ],
  },
});
