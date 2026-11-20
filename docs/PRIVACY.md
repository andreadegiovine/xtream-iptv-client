# Xtream IPTV — Privacy policy

Last updated: November 2026.

Xtream IPTV is a player for the IPTV service the user already subscribes to. It has no account, no advertising and no analytics.

## What the app stores, and where

Everything stays on the device that runs the app:

- the provider details the user types (server address, username and password, or playlist and guide addresses);
- the downloaded catalog and TV guide;
- favourites, collections, pins, watch history and progress, settings;
- the optional keys the user types for TMDB, Trakt and OpenSubtitles.

Nothing of this is sent to the developer, who runs no server that receives data from the app.

The alerts of scheduled viewing are set on the device itself (Android and desktop notifications, an alarm of the Samsung TV that starts
the app): the system keeps the programme title and time until the alert comes; no push service is used. On Android the app
asks for the notification permission (Android 13 and later) and, where needed, for "Alarms & reminders", the first time a programme is
scheduled.

## Who the app talks to

- **The user's IPTV provider**, at the addresses the user typed: to read the catalog and the guide and to play the streams.
- **TMDB** (api.themoviedb.org), only when the user typed a TMDB key: title identifiers and the app language, to read posters, plots, cast and recommendations.
- **Trakt** (api.trakt.tv), only when the user connected a Trakt account: watched titles and playback progress, to keep the user's history in sync.
- **OpenSubtitles** (api.opensubtitles.com), only when the user typed an OpenSubtitles key and asks for subtitles: the title identifier, the language and a hash of the video file (computed from its first and last 64 KB), to find subtitles.
- **YouTube**, only when the user plays a trailer.
- **The device sync repository on GitHub** (api.github.com, see docs/SYNC_REPO.md), only when the user logs in to a sync account in Settings › Sync: the synced data (providers with their credentials, settings, profiles without PINs, keys, Trakt account, watch state, favourites, collections) is encrypted on the device with a key derived from the account's password (AES-256-GCM, PBKDF2) and stored as one file per account, named after a hash of the username. The password never leaves the device; the file is public but cannot be read without it. Accounts not used for 30 days are deleted.
- **GitHub Pages** (andreadegiovine.github.io), only in the "autoupdate" packages distributed outside the TV stores: to check for and download a newer version of the app. The store packages never contact it.

- **Diagnostics › Share the logs**, only when the user asks: the newest log lines (credentials masked) are put in a QR code; the phone that scans it opens a page on GitHub Pages and decodes them there. The logs travel after the `#` of the link, which a browser never sends to the server: GitHub receives only the request for the page.

Each service handles the data it receives under its own privacy policy.

## Deleting the data

Settings → Device lets the user delete the downloaded data or reset the app; uninstalling the app deletes everything it stored. The data of a sync account is deleted from GitHub 30 days after the last TV used it (Settings › Sync › Remove takes a TV out of the sync and resets it).

## Contact

Questions about this policy: open an issue at https://github.com/andreadegiovine/xtream-iptv-client/issues.
