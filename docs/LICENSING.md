# Trial builds and activation

The `_trial` packages are the base package of every platform with the trial (`_tizen_trial.wgt`, `_webos_trial.ipk`,
`_androidtv_trial.apk`, `_firetv_trial.apk`, `_windows-x64_trial.exe`, `_macos-*_trial.dmg`, `_linux-x64_trial.*`): the packages for the
official stores, which update them (no online updates, no YouTube service). They work for **30 days**, then stop and show a QR code: the
device is activated with a **one-time payment** and stays activated for life. The other packages are unchanged.

## How it works

```
TV (trial build)                 Cloudflare worker                    GitHub (private repo)        PayPal
  start ── POST /check {key} ──▶  licenses/KEY.json? ─────────────────▶ read
                                  trials/KEY.json?   ─────────────────▶ read / create (first time)
        ◀── {active} or {endsAt, now}
  QR ───── GET /pay?key=KEY ────▶ create order (custom_id = KEY) ──────────────────────────────────▶ Orders API
       phone ◀── 302 to PayPal's page ◀──────────────────────────────────────────────────────────── payment page
       phone ── GET /return?token=ORDER ▶ capture the order ─────────────────────────────────────────▶ Orders API
                                  checked, then create licenses/KEY.json ─▶ write
```

- **The device key.** `platform.deviceId()` reads an id of the system that does not change when the app is reinstalled or its files
  are deleted: Tizen's DUID, webOS's LGUDID, Android's `ANDROID_ID`, the computer's id on desktop (Windows `MachineGuid`, macOS
  `IOPlatformUUID`, Linux `/etc/machine-id`). The app hashes it into a 12-character key (`ABCD-EFGH-JKMN`, `src/services/licensing.js`):
  only the key leaves the device, shown in Settings › Activation and on the lock screen.
- **Trial.** At every start, until the device is activated, the app asks the worker (`POST /check`). The first time a key is seen the
  worker writes `trials/<KEY>.json` with the server's time: reinstalling the app does not start a new trial. The app keeps the trial's
  end (corrected by the server's clock) and counts down; when it ends the lock screen takes the screen and every key, and asks the worker
  again every 20 seconds.
- **Activation.** The QR code opens `/pay?key=KEY`: the worker creates a PayPal order of the price with the key as `custom_id` (PayPal's
  Orders API, with an app of its own) and sends the phone to PayPal's page. After the payment PayPal sends the phone back to `/return`;
  the worker captures the order itself and, when the capture is `COMPLETED`, in the right currency and at least the price, for a device
  key, writes `licenses/<KEY>.json`. No notification from PayPal is needed and the account's settings (and its other projects) are not
  touched: the return address belongs to each order. The app unlocks by itself at its next check (within 20 seconds on the lock
  screen); once activated it saves it and **never asks again**. A payment closed before coming back is not captured (PayPal releases it):
  the user pays again from the QR code. A payment PayPal holds for review (`PENDING`) writes nothing. Refunds are made in PayPal and the
  licence file is deleted by hand (devices that already saved the activation stay activated).
- **Offline.** Without an answer the app uses what it saved. A device never checked (no network since the first start) works for 3
  days, then asks to be connected.
- **Privacy.** The repository holds only keys (hashes), dates, the PayPal order and capture ids and the amount: no device id, no name, no
  email. The GitHub token and the PayPal secret live only in the worker.

## Setup (once)

1. **Licences repository.** Create a private GitHub repository, e.g. `xtream-iptv-licenses` (empty, with a README so it has a `main`
   branch). Create a fine-grained token with access to that repository only, permission *Contents: Read and write*.
2. **PayPal app.** On developer.paypal.com › Apps & Credentials create an app (first in Sandbox, later in Live) for the account that
   receives the payments: its **Client ID** and **Secret** are for this worker only.
3. **Worker.** From the dashboard: create the worker, paste `licensing/worker/src/index.js`, deploy; in its settings add the variables
   `GITHUB_REPO`, `PAYPAL_CLIENT_ID`, `PRICE`, `CURRENCY`, `ITEM_NAME`, `TRIAL_DAYS`, `PAYPAL_SANDBOX` and the secrets `GITHUB_TOKEN`,
   `PAYPAL_CLIENT_SECRET`; turn Workers Logs on (Observability). Or from the command line, with the values in `wrangler.toml`:
   ```bash
   npx wrangler login
   ```
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
   ```bash
   npx wrangler secret put PAYPAL_CLIENT_SECRET
   ```
   ```bash
   npx wrangler deploy
   ```
   The address it prints (e.g. `https://xtream-iptv-licensing.<account>.workers.dev`) is the licence URL.
   Open `<address>/health`: the settings in use (never a secret), whether the token can write the repository (`"github": { "ok": true,
   "push": true }`) and whether PayPal accepts the app's credentials (`"paypal": { "ok": true }`). Every payment is logged
   (`Payment <order>: activated`, or why nothing was written); errors as `Error on /return: …`.
4. **Test, then live.** With `PAYPAL_SANDBOX = "true"` and the sandbox app, pay from `<address>/pay?key=TEST-0000-0001` with a sandbox
   personal account: `licenses/TEST-0000-0001.json` appears. Then the Live app's Client ID and Secret, `PAYPAL_SANDBOX = "false"`, deploy.
5. **Builds.** In the player repository: *Settings › Secrets and variables › Actions › Variables*, add `LICENSE_URL` with the worker's
   address. The release workflow builds the `_trial` packages with it.

## Notes

- The webOS trial packages ask for the `deviceid.query` permission (appinfo.json, added at build time): to verify on a TV.
- On a desktop the computer's id can be read by the user; anyone able to rebuild the app can remove the trial: it stops normal users, the
  official signed packages are the ones that count.
- Google Play and Amazon require their own billing for unlocking digital features: see the open points in MILESTONES.md.
