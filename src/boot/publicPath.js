/* global __webpack_public_path__: writable, __webpack_get_script_filename__: writable */ /* eslint-disable-line no-unused-vars */
/*
 * First module of the app: when the loader in index.html (src/boot/loader.js) started an update kept on the device, the chunks and the
 * workers come from there too.
 * - Files (`window.__XI_BASE__`, the folder of the slot): the chunks are read from that folder. A worker whose script is not on the page's
 *   origin (Tizen's file:// folder, an older online build) is started from a blob that imports it.
 * - A database (`window.__XI_FILES__`, { "js/x.js" → blob: address }): every chunk and worker has its own blob address; inside a worker the
 *   chunks it imports by name are given theirs.
 */
const w = typeof window !== 'undefined' ? window : null;
const base = w ? w.__XI_BASE__ : '';
const files = w ? w.__XI_FILES__ : null;

if (files) {
  const nameOf = __webpack_get_script_filename__;
  __webpack_get_script_filename__ = (chunkId) => {
    const name = nameOf(chunkId);
    return files[name] || name;
  };
} else if (base) {
  __webpack_public_path__ = base;
}

const NativeWorker = w && w.Worker;
if (NativeWorker && (files || base)) {
  const elsewhere = (url) => {
    const text = String(url);
    if (/^blob:/i.test(text)) return Boolean(files);
    if (/^https?:/i.test(text)) return text.indexOf(w.location.origin) !== 0;
    return /^file:/i.test(text) && w.location.protocol !== 'file:';
  };
  // Inside the worker: importScripts("js/x.js") (the chunks a worker reads by name, relative to it) gets the address of that file: its
  // blob address, or the folder of the slot (a worker started from a blob has no folder of its own).
  const prelude = `(function(){var m=${JSON.stringify(files || {})},b=${JSON.stringify(base || '')},o=self.importScripts;self.importScripts=function(){return o.apply(self,Array.prototype.map.call(arguments,function(u){return m[u]||(/^[a-z]+:/i.test(u)?u:b+u);}));};})();`;
  const Patched = function Worker(url, options) {
    if (!elsewhere(url) && !(files && /^blob:/i.test(String(url)))) return new NativeWorker(url, options);
    const blob = new Blob([`${prelude}importScripts(${JSON.stringify(String(url))});`], { type: 'text/javascript' });
    return new NativeWorker(URL.createObjectURL(blob), options);
  };
  Patched.prototype = NativeWorker.prototype;
  w.Worker = Patched;
}
