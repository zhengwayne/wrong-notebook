# FAQ

## How do I sign in after a fresh install? Does upgrading reset the password?

Fresh installs have no default account. On first start the server generates a one-time setup link (`/initialize?token=…`); open it to choose the admin email and password:

- Desktop and standalone Android apps: opened automatically on first launch.
- Docker: read the token with `docker exec wrong-notebook cat /app/config/setup-token`.
- fnOS: set the admin email and password in the install wizard and sign in with them; no setup link is needed.
- npm and source installations: read the file at the path in the startup log. The defaults are `~/.wrong-notebook/config/setup-token` for npm and `config/setup-token` in the project for source runs.
- In your browser, enter the server address followed by `/initialize?token=`, paste the token after the equals sign, and open the page.

If the link host is `localhost`, replace it with the server IP or domain when opening it from another device. The link works only once and stops working after the admin is created; until then, the sign-in page shows these instructions.

Instances installed with earlier versions have the default admin `admin@localhost`. If that account still uses the legacy default password, change it when prompted after signing in. Startup and upgrades preserve the roles and activation status of existing accounts. If you forget the password, see [`scripts/reset-password.js`](https://github.com/margrop/wrong-notebook/blob/main/scripts/reset-password.js) in the repository, and back up first.

## Sign-in bounces back to the login page, or fails behind a reverse proxy?

Check that `NEXTAUTH_URL` equals the full address the browser actually uses, that `NEXTAUTH_SECRET` is set and stays the same after recreating the container, and that the proxy forwards the host and protocol correctly. Sign in again once the configuration takes effect.


## "Too many failed attempts" when signing in?

To stop brute-force attacks, sign-in is paused for 15 minutes after 5 wrong passwords for one account, or 20 failed sign-ins from one IP, within 15 minutes; during the pause even the correct password is rejected. Sign-up and the setup link allow at most 10 attempts per IP per hour. Try again after the wait, or restart the service to clear the counters. Behind a reverse proxy, forward `X-Real-IP` or `X-Forwarded-For` and set `TRUST_PROXY=true` (with `TRUSTED_PROXY_HOPS`) or `TRUST_PROXY=cloudflare`; by default `TRUST_PROXY=false` ignores proxy IP headers so clients cannot spoof them.

## I changed environment variables but the AI still uses the old configuration?

Fields saved in the web UI take precedence over environment variables. Check the provider, model and active instance in "Settings → AI Provider" first. After changing container environment variables, recreate the container; once the web configuration is saved, later AI requests read it.

## The connection test passes but image recognition fails?

A successful connection does not mean the model accepts images. Make sure the chosen model has vision capability, the compatible API accepts image requests, the image is complete and readable, and the server can reach the provider. `localhost` inside a container is the container itself; see [AI Configuration](AI-Configuration-en).

## "AI response format error", or animation generation fails?

Check whether the model follows the tag or JSON output format and whether its maximum output length is large enough. Animations contain long SVG code and are easily truncated by short output limits. Switch to a more suitable model; on timeouts, check the network and adjust the admin analysis timeout.

## Animation narration is silent, or the speaker button is unavailable?

By default, narration uses the browser's built-in speech synthesis and does not call any AI service. Admins can switch to cloud voice under **Settings → AI → Voice narration**; cloud voice does not depend on the voices installed on the device and falls back to the browser's voice if synthesis fails. A grayed-out speaker button means the browser has no voice for that language: Linux browsers often lack a Chinese voice that must be installed in the system, and the Android app's built-in browser is not supported yet. If the button works but there is no sound, check the device volume and mute switch; on iPhone, turn off silent mode. Safari on iPhone and iPad only plays speech after a tap: if an auto-playing animation is silent, tap the page or the play button to start the narration.

## The screenshot button is unavailable?

Screenshots use the browser's `getDisplayMedia()`, which requires an HTTPS or `localhost` secure context plus browser and OS support with permission to share the screen. Accessing the app through a LAN HTTP address usually does not qualify; even with HTTPS, mobile browsers may not support it, so take a photo, upload or paste an image instead.

## Formulas show as source, or a figure is wrong?

Check the formula delimiters, backslashes and KaTeX-supported syntax using the source/preview toggle; when the detail page detects errors, try "Fix LaTeX". SVG figures are generated by the AI, so compare geometric relationships with the original image and regenerate when needed.

## The question count did not increase after importing?

The import may have matched duplicate detection. Check the message and the original question's answer history; a duplicate is recorded as another wrong attempt on the original. The default threshold is 90% and a question is a duplicate when the similarity is strictly greater; adjust it in your personal settings. See the [User Guide](User-Guide-en).

## Why do the difficulty and paper A/B differ?

Difficulty and paper level are separate fields. When the paper level is not set, 1–3 stars default to paper A and 4–5 stars to paper B; a manually chosen paper level is kept. Changing the stars does not overwrite an existing manual choice.

## The AI analysis percentage is stuck for a long time?

The percentage is an estimate for the current stage; AI services usually do not report real progress. Use the stage description, elapsed time and background task status, read the error after a timeout, and avoid submitting the same task repeatedly.

## A background task says "Interrupted by a server restart"?

The background task list is persisted in the SQLite `AsyncOperation` table, so tasks that finished in the last 30 minutes are still listed after a restart. AI calls run inside the app process; tasks still running at restart are marked `interrupted` during startup recovery and shown as failed with "Interrupted by a server restart". Before retrying, check whether the question or exam paper was already saved; the task list only shows progress, and the notebooks and exam pages are the source of truth for saved data.

## Does HTTP 207 mean the Openclaw import succeeded?

`207` means some items in the batch failed; with the current implementation it can be returned even when every recognition failed. Always read `successCount`, `failCount` and each item in `results`. The per-image recognition timeout is at least 3 seconds; see [Openclaw Integration](Openclaw-Integration-en) for more limits.

## Can web ZIP / JSON exports restore the whole site?

The default **v3 ZIP archive** migrates complete personal and multi-role data (including child profiles, parent papers, teacher grading, variant stages, and learning paths, with optional AES-256-GCM passphrase encryption), but web exports never include password hashes or server-side AI credentials. A full-site disaster recovery still needs the complete SQLite database (or `backups/` snapshots), `config/`, deployment configuration, and TLS certificates; see [Backup and Restore](Backup-and-Restore-en).

## What if the home page warns about a failed database snapshot, or SQLite reports `SQLITE_BUSY` on a NAS?

- **Failed daily snapshot**: check disk space and write permissions on the `backups/` folder inside your data directory, then inspect the timestamp or retry manually via **Snapshot Now** under **Settings → Danger**. If your host already snapshots volumes, set `DAILY_SNAPSHOT_ENABLED=false`.
- **Locks on NAS NFS/CIFS shares**: network filesystems often lack cross-node shared-memory locks for WAL (`-shm`); set `SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` and restart the container.

## Data is missing after an upgrade, or the container won't start?

First check that the original `data/` and `config/` are still mounted at `/app/data` and `/app/config`, then look for migration and permission errors in the container logs. Do not delete the data directory to try to fix it; keep the current state and backups, and check version compatibility following the [deployment guide](Deployment-en).

## How do I report a problem?

Open a [GitHub issue](https://github.com/margrop/wrong-notebook/issues) with the running version, deployment method, browser, steps to reproduce and redacted logs. Admins can turn on debug mode under "Settings → User Management", reproduce the problem and attach the exported debug log; see [Debug logs](Settings-and-Users-en#debug-logs). The version is shown in "About" in the settings or at `/api/health`; do not include API keys, passwords, session data or a full database.
