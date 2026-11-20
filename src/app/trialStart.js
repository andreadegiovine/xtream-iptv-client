import { log } from '../core/logger.js';

/**
 * The trial start of an update kept on the device (src/boot/loader.js): before the app opens its databases (a newer version may change
 * them, and the previous one could not read them any more), the update shows that its code is all there and runs. Every page is read
 * and a worker answers; then the loader keeps it. Anything wrong: the loader removes it and starts the previous version again.
 */
function workerAnswers(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let worker = null;
    const timer = setTimeout(() => {
      if (worker) worker.terminate();
      reject(new Error(`no worker answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    try {
      worker = new Worker(new URL('../workers/ping.worker.js', import.meta.url));
      worker.onmessage = (event) => {
        clearTimeout(timer);
        worker.terminate();
        if (event.data === 2) resolve();
        else reject(new Error('unexpected worker answer'));
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(`worker error ${(event && event.message) || ''}`));
      };
      worker.postMessage(1);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** `pages`: the loaders of the pages read when first opened (main.js LAZY_PAGES). Resolves once the loader kept the update. */
export async function confirmTrial(slots, pages) {
  if (!slots || !slots.onTrial()) return false;
  const version = typeof window !== 'undefined' ? window.__XI_BUNDLE__ : '';
  log.info(`Version ${version}: first start, checking it before opening the databases`);
  for (const name of Object.keys(pages)) {
    try {
      await pages[name]();
    } catch (err) {
      throw new Error(`page ${name} did not load: ${(err && err.message) || err}`);
    }
  }
  await workerAnswers();
  await slots.confirm();
  log.info(`Version ${version} works: kept, the previous one removed`);
  return true;
}
