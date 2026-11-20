# The device sync repository

"Settings › Sync devices" keeps several TVs the same (providers, settings, profiles, keys, Trakt, watch state, favourites, collections,
pinned entries). The data of every account lives, encrypted on the TV with the account's password, in one file per account of a GitHub
repository of its own. This document says how it is set up, and how to make a new one if GitHub blocks or removes it.

## Where the app finds it

- `src/services/sync/config.js`: `SYNC_REPO` (`owner/name`) and `SYNC_BRANCH`. Change them there to move to another repository.
- The token: the `SYNC_TOKEN` secret of this repository (Settings → Secrets and variables → Actions), put into every build by the
  release workflow (`__SYNC_TOKEN__`, webpack.config.js). A build without it has no sync: its Settings page and its first-start "Account"
  button are not shown. Local builds: `SYNC_TOKEN=... npm run build`.
- The build stores the token encoded (`scripts/sync-token.js`: every character XOR 0x5a, as hex, reversed; decoded by
  `decodeSyncToken` in config.js), so its plain form never appears in the builds published on the public gh-pages branch. It is part of
  the app's code: the updates of the "_autoupdate" packages bring a new token; the store packages need a new package.
- Current repository: `andreadegiovinebk/xtream-iptv-client-bk`, owned by a separate GitHub account (a problem there never touches the
  app's own account and releases).

## How it works

- The app reads `users/<account>.json` with the GitHub API (with its ETag: an unchanged file costs no download) and sends changes as a
  `repository_dispatch` event (`event_type: sync`). The workflow `.github/workflows/sync.yml` checks the write key, merges the items (the
  newer of each one wins, `.github/scripts/merge.js`) and commits with a deploy key.
- Rulesets block every push to the repository except the deploy key's: the token inside the app (fine-grained, Contents read/write on
  that repository only) can read and start the workflow, never write a file itself.
- `.github/workflows/cleanup.yml` (daily): accounts not used for 30 days and accounts created without data after a day are removed; the
  history is squashed into one commit so the repository does not grow.
- A copy of every file of the repository is in `docs/sync-repo-template/` (keep it the same as the repository when either changes).

## Making a new repository

1. **Account.** Create a new GitHub account for it (one "machine" account per person is allowed), or use the existing one.
2. **Repository.** A new public repository, with a README so it has a first commit. Copy into it the content of
   `docs/sync-repo-template/` (`.github/`, `README.md`, `users/.gitkeep`) and push it before step 5.
3. **Deploy key.** On a computer:
   ```bash
   ssh-keygen -t ed25519 -C "sync-deploy" -f sync_deploy_key -N ""
   ```
   - Repository → Settings → Deploy keys → Add deploy key: title `workflow`, key = `sync_deploy_key.pub`, tick *Allow write access*.
   - Repository → Settings → Secrets and variables → Actions → New repository secret: `DEPLOY_KEY` = the content of `sync_deploy_key`.
   - Delete both files afterwards.
4. **Token.** Avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token:
   resource owner the account of the repository, *Only select repositories* (that one), Repository permissions → *Contents: Read and
   write* (nothing else), the longest expiration available (note the date: a new token needs a new release, which the "_autoupdate"
   packages receive by themselves). Put it in the app repository as the `SYNC_TOKEN` secret.
5. **Rulesets.** Repository → Settings → Rules → Rulesets:
   - New branch ruleset `solo-workflow`: Enforcement *Active*; Bypass list: *Deploy keys* only (not *Repository admin*: the token's owner
     is the admin, it would bypass too); Target *Include all branches*; rules *Restrict creations*, *Restrict updates*, *Restrict
     deletions*, *Block force pushes*.
   - New tag ruleset: the same, target *All tags*, rules *Restrict creations / updates / deletions*.
   - Settings → Actions → General → Workflow permissions: *Read repository contents*.
6. **Check.** With the token in `$SYNC_TOKEN`, a direct write must fail (409/422 naming the rules, not "repository is empty") and a
   dispatch must answer 204 (a "Sync" run appears under Actions):
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $SYNC_TOKEN" https://api.github.com/repos/OWNER/REPO/contents/prova.txt -d '{"message":"prova","content":"cHJvdmE="}'
   ```
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $SYNC_TOKEN" https://api.github.com/repos/OWNER/REPO/dispatches -d '{"event_type":"sync","client_payload":{}}'
   ```
7. **App.** Set `SYNC_REPO` in `src/services/sync/config.js`, publish a release (the builds take the new `SYNC_TOKEN`).

Changing the workflow later: set the rulesets to *Disabled*, push, set them back to *Active*.

## What happens to the accounts

The accounts of a removed repository are lost with it, but every TV keeps its own data. Once a TV runs a build that points at the new
repository, its next sync finds no account there and makes it again with the data of that TV (same username and password); the other TVs
of the account then find it and keep syncing. Older builds keep pointing at the old repository: their sync stops working (the app
itself is not affected).
