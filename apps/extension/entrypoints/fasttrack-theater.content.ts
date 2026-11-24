import { FastTrackTheaterController } from '../src/adapters/fasttrack/theaterController';
import { loadSettings } from '../src/storage/settingsStore';

export default defineContentScript({
  matches: ['*://fasttracktutorials.com/*', '*://*.fasttracktutorials.com/*'],
  runAt: 'document_idle',
  main() {
    // Only run in top-level FastTrack pages
    if (window !== window.top) return;

    const controller = new FastTrackTheaterController(document);

    void loadSettings().then((settings) => {
      controller.start(settings.fastTrackAutoTheater);
    });

    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['dubcera_settings_v1']) return;
      void loadSettings().then((settings) => {
        controller.setAutoEnabled(settings.fastTrackAutoTheater);
      });
    });

    window.addEventListener('pagehide', () => controller.dispose());
    window.addEventListener('beforeunload', () => controller.dispose());
  },
});
