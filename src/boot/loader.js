/* global module */
/* eslint no-unused-vars: ["warn", { "caughtErrors": "none" }] */
/*
 * The loader of the page (inlined in index.html, plain ES5: it runs before anything else, on the oldest TV too). It starts the app from
 * the package's own copy or from an update installed on the device, and keeps those updates (see src/services/slotUpdates.js).
 *
 * Updates live in two slots, "a" and "b", on the device itself: real files where the platform allows it (Android / Fire TV, desktop,
 * Tizen), otherwise a database of their own (webOS). A slot holds the files of one version, checked against their SHA-256, and `slot.json`:
 * { version, state, files }. `state` is "trial" (downloaded, never started) or "ok" (it started). At every start:
 *  - a slot not newer than the package is removed (a newer package was installed);
 *  - a "trial" slot is started on trial: the app confirms it (`__XI_SLOTS__.confirm()`) once its code is all there and before it touches the
 *    databases; then the slot is "ok" and the other slot is emptied. A trial that does not confirm (an error, nothing within TRIAL_MS, or a
 *    start that never came back) removes its slot and starts the previous one again: the databases were not touched;
 *  - otherwise the "ok" slot, otherwise the package's copy;
 *  - a slot whose files do not load (they were removed from the device) is not replaced by the package's copy, which may not read the
 *    databases the update changed: the package's copy starts in "rescue" mode (the screen of a failed start, with the update check).
 * The next update is downloaded into the slot not in use.
 */
(function (root, factory) {
  var lib = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.__XI_LOADER__ = lib;
})(typeof window !== 'undefined' ? window : this, function (win) {
  var SLOTS = ['a', 'b'];
  var TRIAL_MS = 90000;
  var TRIAL_KEY = 'xi.trial'; // "<slot>@<version>" while a slot is on trial (still there at the next start: the trial never confirmed)
  var FAILED_KEY = 'xi.updateFailed'; // { version, reason, at }: the app tells it and does not download that version again by itself
  var MODE_KEY = 'xi.slotMode'; // "db": the files did not work on this device (Tizen), the database is used instead
  var LEGACY_KEY = 'xi.bundle'; // the earlier updates (loaded from the network at every start): no longer used by this loader

  function newer(a, b) {
    var x = String(a || '0').split('.');
    var y = String(b || '0').split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i += 1) {
      var d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (d) return d > 0;
    }
    return false;
  }

  function storage() {
    try {
      return win.localStorage || null;
    } catch (e) {
      return null;
    }
  }
  function getItem(key) {
    var s = storage();
    try {
      return s ? s.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }
  function setItem(key, value) {
    var s = storage();
    try {
      if (s) {
        if (value === null) s.removeItem(key);
        else s.setItem(key, value);
      }
    } catch (e) {
      /* storage not available */
    }
  }

  /**
   * What to start, from what the two slots hold: { run: slot name or null (the package's copy), trial, remove: [slot names] }.
   * `metas`: { a: meta or null, b: meta or null }; `tried`: the TRIAL_KEY left by a start that never confirmed.
   */
  function pickStart(metas, shell, tried) {
    var remove = [];
    var failed = null;
    var trial = null;
    var ok = null;
    SLOTS.forEach(function (name) {
      var meta = metas[name];
      if (!meta) return;
      if (!meta.version || !newer(meta.version, shell) || (meta.state !== 'trial' && meta.state !== 'ok')) {
        remove.push(name);
        return;
      }
      if (meta.state === 'trial') {
        if (tried === name + '@' + meta.version) {
          remove.push(name);
          failed = { slot: name, version: meta.version };
        } else if (!trial || newer(meta.version, metas[trial].version)) trial = name;
      } else if (!ok || newer(meta.version, metas[ok].version)) ok = name;
    });
    // A trial not newer than the version that works is of no use.
    if (trial && ok && !newer(metas[trial].version, metas[ok].version)) {
      remove.push(trial);
      trial = null;
    }
    return { run: trial || ok, trial: Boolean(trial), remove: remove, failed: failed };
  }

  /* ---------------------------------------------------------------- SHA-256 (the files of an update are checked against it) */

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  /** The SHA-256 of bytes (Uint8Array) as hex, in plain JavaScript (crypto.subtle is not there on every TV page). */
  function sha256Hex(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var length = bytes.length;
    var total = ((length + 9 + 63) >> 6) << 6;
    var data = new Uint8Array(total);
    data.set(bytes);
    data[length] = 0x80;
    var bits = length * 8;
    var view = new DataView(data.buffer);
    view.setUint32(total - 4, bits >>> 0);
    view.setUint32(total - 8, Math.floor(bits / 0x100000000));
    var w = new Array(64);
    for (var offset = 0; offset < total; offset += 64) {
      var i;
      for (i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (i = 16; i < 64; i += 1) {
        var a0 = w[i - 15];
        var a1 = w[i - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0];
      var b = h[1];
      var c = h[2];
      var d = h[3];
      var e = h[4];
      var f = h[5];
      var g = h[6];
      var hh = h[7];
      for (i = 0; i < 64; i += 1) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }
    var out = '';
    for (var j = 0; j < 8; j += 1) out += ('00000000' + (h[j] >>> 0).toString(16)).slice(-8);
    return out;
  }

  /* ---------------------------------------------------------------- where the slots are kept, per platform */

  var MIME = { js: 'text/javascript', css: 'text/css', json: 'application/json', woff2: 'font/woff2' };
  var mimeOf = function (path) {
    return MIME[String(path).split('.').pop()] || 'application/octet-stream';
  };
  var asBytes = function (data) {
    return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  };

  function readMetaByUrl(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function toBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return win.btoa(out);
  }

  /** Desktop (Electron): files in the user's data folder, served at app://xtream/__slot/<slot>/ (platforms/desktop/electron). */
  function desktopStore(api) {
    var base = function (slot) {
      return win.location.origin + '/__slot/' + slot + '/';
    };
    return {
      kind: 'files',
      meta: function (slot) {
        return readMetaByUrl(base(slot) + 'slot.json');
      },
      write: function (slot, path, data) {
        return api.write(slot, path, asBytes(data));
      },
      remove: function (slot) {
        return api.remove(slot);
      },
      base: base,
    };
  }

  /** Android / Fire TV: files in the app's private storage, served at http://localhost/__slot/<slot>/ (ProviderWebViewClient). */
  function androidStore(cap) {
    var base = function (slot) {
      return win.location.origin + '/__slot/' + slot + '/';
    };
    return {
      kind: 'files',
      meta: function (slot) {
        return readMetaByUrl(base(slot) + 'slot.json');
      },
      write: function (slot, path, data) {
        return cap.nativePromise('TvHost', 'slotWrite', { slot: slot, path: path, data: toBase64(asBytes(data)) });
      },
      remove: function (slot) {
        return cap.nativePromise('TvHost', 'slotRemove', { slot: slot });
      },
      base: base,
    };
  }

  /** Tizen: files in the app's private folder (wgt-private), loaded by their file:// address. */
  function tizenStore(fsApi) {
    var ROOT = 'wgt-private/xi-slots/';
    var promise = function (run) {
      return new Promise(function (resolve, reject) {
        try {
          run(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
    };
    var ensureDir = function (dir) {
      return promise(function (resolve, reject) {
        if (fsApi.pathExists(dir)) resolve();
        else fsApi.createDirectory(dir, true, resolve, reject);
      });
    };
    return {
      kind: 'files',
      meta: function (slot) {
        return promise(function (resolve) {
          var path = ROOT + slot + '/slot.json';
          if (!fsApi.pathExists(path)) return resolve(null);
          var handle = fsApi.openFile(path, 'r');
          try {
            resolve(JSON.parse(handle.readString()));
          } finally {
            handle.close();
          }
        }).catch(function () {
          return null;
        });
      },
      write: function (slot, path, data) {
        var full = ROOT + slot + '/' + path;
        return ensureDir(full.slice(0, full.lastIndexOf('/'))).then(function () {
          var handle = fsApi.openFile(full, 'w');
          try {
            if (typeof data === 'string') handle.writeString(data);
            else handle.writeData(new Uint8Array(data));
          } finally {
            handle.close();
          }
        });
      },
      remove: function (slot) {
        return promise(function (resolve, reject) {
          if (!fsApi.pathExists(ROOT + slot)) resolve();
          else fsApi.deleteDirectory(ROOT + slot, true, resolve, reject);
        });
      },
      base: function (slot) {
        return fsApi.toURI(ROOT + slot) + '/';
      },
    };
  }

  /** A database of its own (webOS, and Tizen when its files do not work): the files are started from blob: addresses. */
  function dbStore(idb) {
    var NAME = 'xtream-iptv-slots';
    var STORE = 'files';
    var opened = null;
    var open = function () {
      if (!opened) {
        opened = new Promise(function (resolve, reject) {
          var request = idb.open(NAME, 1);
          request.onupgradeneeded = function () {
            request.result.createObjectStore(STORE);
          };
          request.onsuccess = function () {
            resolve(request.result);
          };
          request.onerror = function () {
            reject(request.error);
          };
        });
      }
      return opened;
    };
    var run = function (mode, work) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, mode);
          var result = work(tx.objectStore(STORE));
          tx.oncomplete = function () {
            resolve(result && 'result' in result ? result.result : undefined);
          };
          tx.onerror = function () {
            reject(tx.error);
          };
          tx.onabort = function () {
            reject(tx.error || new Error('aborted'));
          };
        });
      });
    };
    var get = function (key) {
      return run('readonly', function (store) {
        return store.get(key);
      });
    };
    return {
      kind: 'db',
      meta: function (slot) {
        return get(slot + '/slot.json')
          .then(function (text) {
            return text ? JSON.parse(text) : null;
          })
          .catch(function () {
            return null;
          });
      },
      write: function (slot, path, data) {
        return run('readwrite', function (store) {
          store.put(typeof data === 'string' ? data : new Uint8Array(data).buffer, slot + '/' + path);
        });
      },
      remove: function (slot) {
        return run('readwrite', function (store) {
          store.delete(IDBKeyRange.bound(slot + '/', slot + '/￿'));
        });
      },
      /** blob: addresses of the files of a slot ({ path → address }); the stylesheets point at the fonts of the slot. */
      urls: function (slot, meta) {
        var files = meta.files || [];
        return Promise.all(
          files.map(function (path) {
            return get(slot + '/' + path);
          })
        ).then(function (bodies) {
          var map = {};
          var styles = [];
          files.forEach(function (path, i) {
            if (bodies[i] === undefined || bodies[i] === null) throw new Error('missing ' + path);
            if (/\.css$/.test(path)) styles.push(i);
            else map[path] = URL.createObjectURL(new Blob([bodies[i]], { type: mimeOf(path) }));
          });
          styles.forEach(function (i) {
            var body = bodies[i];
            var text = typeof body === 'string' ? body : new TextDecoder().decode(new Uint8Array(body));
            text = text.replace(/url\((['"]?)\.\.\/(fonts\/[^)'"]+)\1\)/g, function (all, quote, font) {
              return map[font] ? 'url(' + quote + map[font] + quote + ')' : all;
            });
            map[files[i]] = URL.createObjectURL(new Blob([text], { type: 'text/css' }));
          });
          return map;
        });
      },
    };
  }

  /** The store of this device, or null (no way to keep updates). */
  function pickStore() {
    try {
      if (win.xtreamDesktop && win.xtreamDesktop.slots) return desktopStore(win.xtreamDesktop.slots);
      var cap = win.Capacitor;
      if (cap && typeof cap.nativePromise === 'function' && (!cap.getPlatform || cap.getPlatform() === 'android')) return androidStore(cap);
      var fsApi = win.tizen && win.tizen.filesystem;
      if (fsApi && typeof fsApi.openFile === 'function' && typeof fsApi.toURI === 'function' && getItem(MODE_KEY) !== 'db') return tizenStore(fsApi);
      if (win.indexedDB) return dbStore(win.indexedDB);
    } catch (e) {
      /* no store */
    }
    return null;
  }

  /* ---------------------------------------------------------------- the start */

  function addFiles(css, js, onError) {
    css.forEach(function (href) {
      var link = win.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      win.document.head.appendChild(link);
    });
    js.forEach(function (src) {
      var script = win.document.createElement('script');
      script.src = src;
      script.async = false;
      if (onError) script.onerror = onError;
      win.document.body.appendChild(script);
    });
  }

  /**
   * Starts the app. `options`: { shell (the package's version), autoupdate (this package keeps updates), js, css (the files of the build,
   * relative: "js/main.js") }.
   */
  function start(options) {
    var shell = options.shell;
    win.__XI_SHELL__ = shell;
    win.__XI_BUNDLE__ = '';
    var packageStarted = false;
    var startPackage = function (rescue) {
      if (packageStarted) return;
      packageStarted = true;
      win.__XI_BASE__ = '';
      win.__XI_BUNDLE__ = '';
      if (rescue) win.__XI_RESCUE__ = rescue;
      addFiles(options.css, options.js, null);
    };
    var store = options.autoupdate ? pickStore() : null;
    if (!store) {
      startPackage(null);
      return;
    }
    setItem(LEGACY_KEY, null);

    var running = '';
    var runningMeta = null;
    var watchdog = null;
    var onTrialError = null;
    var reload = function () {
      win.location.reload();
    };

    var api = {
      kind: store.kind,
      slots: SLOTS.slice(),
      sha256Hex: sha256Hex,
      running: function () {
        return running;
      },
      /** The slot an update is downloaded into: the one not in use. */
      free: function () {
        return running === 'a' ? 'b' : 'a';
      },
      meta: function (slot) {
        return store.meta(slot);
      },
      write: function (slot, path, data) {
        return store.write(slot, path, data);
      },
      remove: function (slot) {
        return store.remove(slot);
      },
      /** Whether this start is the trial of an update. */
      onTrial: function () {
        return Boolean(watchdog);
      },
      /** The update on trial works (its code is all there): the slot is kept, the other one emptied. Before the databases are opened. */
      confirm: function () {
        if (!watchdog) return Promise.resolve();
        clearTimeout(watchdog);
        watchdog = null;
        win.removeEventListener('error', onTrialError);
        setItem(TRIAL_KEY, null);
        var meta = { version: runningMeta.version, state: 'ok', files: runningMeta.files, savedAt: runningMeta.savedAt, confirmedAt: Date.now() };
        var other = running === 'a' ? 'b' : 'a';
        return store
          .write(running, 'slot.json', JSON.stringify(meta))
          .then(function () {
            return store.remove(other);
          })
          .catch(function () {
            /* the next start tries again */
          });
      },
      /** The update on trial does not work: its slot is removed and the app starts again from the previous one. */
      fail: function (reason) {
        if (!watchdog && running) return Promise.resolve(false);
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
        setItem(FAILED_KEY, JSON.stringify({ version: runningMeta ? runningMeta.version : '', reason: String(reason || ''), at: Date.now() }));
        setItem(TRIAL_KEY, null);
        var other = running === 'a' ? 'b' : 'a';
        // Tizen: the files themselves may be what does not work on this TV. Only while no version works from them (the database store
        // would not see it): from then on the updates are kept in the database.
        var mode =
          store.kind === 'files' && win.tizen && running
            ? store.meta(other).then(function (meta) {
                if (!meta || meta.state !== 'ok') setItem(MODE_KEY, 'db');
              })
            : Promise.resolve();
        return mode
          .catch(function () {
            /* the files stay */
          })
          .then(function () {
            return store.remove(running);
          })
          .catch(function () {
            /* removed at the next start */
          })
          .then(function () {
            reload();
            return true;
          });
      },
    };
    win.__XI_SLOTS__ = api;

    Promise.all([store.meta('a'), store.meta('b')])
      .then(function (metas) {
        var choice = pickStart({ a: metas[0], b: metas[1] }, shell, getItem(TRIAL_KEY));
        if (choice.failed) setItem(FAILED_KEY, JSON.stringify({ version: choice.failed.version, reason: 'the trial start did not finish', at: Date.now() }));
        setItem(TRIAL_KEY, null);
        choice.remove.forEach(function (slot) {
          store.remove(slot).catch(function () {
            /* removed at the next start */
          });
        });
        if (!choice.run) return startPackage(null);
        running = choice.run;
        runningMeta = choice.run === 'a' ? metas[0] : metas[1];
        if (choice.trial) {
          setItem(TRIAL_KEY, running + '@' + runningMeta.version);
          watchdog = setTimeout(function () {
            api.fail('the trial start did not finish within ' + TRIAL_MS / 1000 + ' s');
          }, TRIAL_MS);
          onTrialError = function (event) {
            api.fail((event && (event.message || (event.error && event.error.message))) || 'error');
          };
          win.addEventListener('error', onTrialError);
        }
        var onFilesError = function () {
          if (packageStarted) return;
          if (watchdog) {
            api.fail('a file of the update did not load');
            return;
          }
          // The files of the version in use are gone: the package's copy may not read what it wrote, it only shows the failed start.
          running = '';
          var links = win.document.querySelectorAll('link[rel=stylesheet]');
          for (var i = 0; i < links.length; i += 1) links[i].parentNode.removeChild(links[i]);
          startPackage({ version: runningMeta.version, reason: 'the files of version ' + runningMeta.version + ' did not load' });
        };
        win.__XI_BUNDLE__ = runningMeta.version;
        if (store.kind === 'db') {
          return store.urls(running, runningMeta).then(function (map) {
            win.__XI_BASE__ = '';
            win.__XI_FILES__ = map;
            var pick = function (file) {
              return map[file];
            };
            addFiles(options.css.map(pick), options.js.map(pick), onFilesError);
          }, onFilesError);
        }
        var base = store.base(running);
        win.__XI_BASE__ = base;
        addFiles(
          options.css.map(function (file) {
            return base + file;
          }),
          options.js.map(function (file) {
            return base + file;
          }),
          onFilesError
        );
        return undefined;
      })
      .catch(function () {
        startPackage(null);
      });
  }

  return { start: start, pickStart: pickStart, sha256Hex: sha256Hex, newer: newer, dbStore: dbStore, keys: { TRIAL_KEY: TRIAL_KEY, FAILED_KEY: FAILED_KEY, MODE_KEY: MODE_KEY } };
});
