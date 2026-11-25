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
  QR ───── GET /pay?key=KEY ────▶ 302 to PayPal (custom = KEY) ───────────────────────────────────▶ payment
                                  POST /ipn ◀──────────────────────────────────────────────────── notification
                                  verify with PayPal, then create licenses/KEY.json ─▶ write
```

- **The device key.** `platform.deviceId()` reads an id of the system that does not change when the app is reinstalled or its files
  are deleted: Tizen's DUID, webOS's LGUDID, Android's `ANDROID_ID`, the computer's id on desktop (Windows `MachineGuid`, macOS
  `IOPlatformUUID`, Linux `/etc/machine-id`). The app hashes it into a 12-character key (`ABCD-EFGH-JKMN`, `src/services/licensing.js`):
  only the key leaves the device, shown in Settings › Activation and on the lock screen.
- **Trial.** At every start, until the device is activated, the app asks the worker (`POST /check`). The first time a key is seen the
  worker writes `trials/<KEY>.json` with the server's time: reinstalling the app does not start a new trial. The app keeps the trial's
  end (corrected by the server's clock) and counts down; when it ends the lock screen takes the screen and every key, and asks the worker
  again every 20 seconds.
- **Activation.** The QR code opens `/pay?key=KEY`, which sends the phone to PayPal with the key as `custom`. PayPal notifies `/ipn`;
  the worker sends the notification back to PayPal (`cmd=_notify-validate`) and, when PayPal says `VERIFIED` and the payment is
  `Completed`, to this account, in the right currency and at least the price, writes `licenses/<KEY>.json`. The app unlocks by itself at
  its next check; once activated it saves it and **never asks again**. A refund or reversal of that payment removes the licence (devices
  that already saved it stay activated).
- **Offline.** Without an answer the app uses what it saved. A device never checked (no network since the first start) works for 3
  days, then asks to be connected.
- **Privacy.** The repository holds only keys (hashes), dates, the PayPal transaction id and the amount: no device id, no name, no email.
  The GitHub token lives only in the worker.

## Setup (once)

1. **Licences repository.** Create a private GitHub repository, e.g. `xtream-iptv-licenses` (empty, with a README so it has a `main`
   branch). Create a fine-grained token with access to that repository only, permission *Contents: Read and write*.
2. **Worker.** In `licensing/worker/`, set the values in `wrangler.toml` (`GITHUB_REPO`, `PAYPAL_EMAIL`, `PRICE`, `CURRENCY`,
   `ITEM_NAME`, `TRIAL_DAYS`, `PAYPAL_SANDBOX`), then:
   ```bash
   npx wrangler login
   ```
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
   ```bash
   npx wrangler deploy
   ```
   The address it prints (e.g. `https://xtream-iptv-licensing.<account>.workers.dev`) is the licence URL.
3. **PayPal.** A business account receiving the payments (`PAYPAL_EMAIL`). The notification address is sent with every payment
   (`notify_url`); check in the PayPal profile that Instant Payment Notifications are not disabled. Test first with `PAYPAL_SANDBOX =
   "true"` and sandbox accounts, then set it to `"false"` and deploy again.
4. **Builds.** In the player repository: *Settings › Secrets and variables › Actions › Variables*, add `LICENSE_URL` with the worker's
   address. The release workflow builds the `_trial` packages with it.

## Notes

- The webOS trial packages ask for the `deviceid.query` permission (appinfo.json, added at build time): to verify on a TV.
- On a desktop the computer's id can be read by the user; anyone able to rebuild the app can remove the trial: it stops normal users, the
  official signed packages are the ones that count.
- Google Play and Amazon require their own billing for unlocking digital features: see the open points in MILESTONES.md.
