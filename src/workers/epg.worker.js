/* EPG worker: downloads and parses the XMLTV guide off the UI thread (logic in services/epgSync.js). */
import { runEpgForProvider } from '../services/epgSync.js';
import { createGate } from '../core/gate.js';

let controller = null;
const gate = createGate(); // held while the user moves around the app (epgService.setHeld)

self.onmessage = function (event) {
  const message = event.data || {};
  if (message.op === 'start') {
    controller = new AbortController();
    runEpgForProvider({ provider: message.provider, others: message.others || [], customUrl: message.customUrl, force: message.force, signal: controller.signal, gate: gate.wait, emit: (payload) => self.postMessage(payload) });
  } else if (message.op === 'cancel' && controller) {
    gate.resume();
    controller.abort();
  } else if (message.op === 'pause') gate.pause();
  else if (message.op === 'resume') gate.resume();
};

self.postMessage({ event: 'ready' });
