# Settings and Users

## Personal preferences

After signing in, open "Settings → General" to adjust your own preferences:

| Setting | Default |
| --- | --- |
| Review before import | When on, review before saving; useful when every question must be checked |
| Grade recognition for new questions | Fixed mode by default: use the chosen grade and semester, or the current account grade if unset; AI recognition is also available |
| SVG animated explanations | On |
| GeoGebra interactive demos | Off |
| Duplicate similarity threshold | 90%; a question is a duplicate when the similarity is strictly greater |
| Mastered threshold | 50%; a question counts as mastered once its mastery probability reaches it |
| Review scheduling algorithm | Default `ebbinghaus-v1` (7 intervals from day 0); switchable to `fsrs-v1` gradual rollout |
| Staged variant pipeline | On by default (plan-then-generate, mathjs verification, independent AI re-solve) |

The interface theme is not in Settings; switch it with the theme button in the top navigation bar: Auto (follow system, the default), Light or Dark. It is also saved per user and carries over when you sign in on another device.

Personal preferences are saved per user. The AI service configuration and the app time zone are global settings that require admin rights.

## Personas and child profiles

Under **Settings → Account**, enable and switch between one or more usage personas, with data strictly isolated by `{ userId, learnerId }`:

- **Student (`self`)**: manage your own notebooks, review queue, and statistics.
- **Parent (`parent`)**: create, rename, and archive up to **3 child profiles**, switch the active child, and upload whole exam papers under `/parent` and `/parent/papers`.
- **Teacher (`teacher`)**: access batch paper grading (`/grading`), student and class profiles (`/teacher`), and class learning paths (`/learn?tab=class`).

Users can update their own password under **Settings → Account** (automatically refreshing the active session while revoking older sessions on other devices via `authVersion`) or permanently delete their own account under **Settings → Danger** (`DELETE /api/user`). Self-service deletion recommends exporting a backup first, verifies the current password, and cascades inside one database transaction to clear all personal business data while recording only a PII-free audit entry (the last active admin remains protected).

## Grade recognition for new questions

Choose a rule under **Settings → General** and click **Save grade rule**. Regular users and admins each manage their own rule.

- **Fixed grade**: use the selected grade and semester. If unset, calculate the current grade from the account's school stage, enrollment year and app time zone. An explicitly selected fixed value stays the same across school years.
- **AI recognition**: infer the grade and semester from the question, knowledge points and curriculum progress, without injecting the student's current grade. Leave them unset when uncertain.
- Applies to image recognition, text solving, batch selection, direct entry and Openclaw uploads. A grade entered manually or changed during review takes priority.
- Image recognition and text solving return the grade in the same AI request. Direct entry and external results missing a grade use one short additional request, counted toward the daily AI limit. Duplicates do not trigger it; an attempted but uncertain result is not requested again.
- Affects new questions only. Existing questions and grades restored from backups stay as they were. Your rule and fixed value are included in your JSON backup.

## App time zone

The app uses Beijing time, `Asia/Shanghai`, by default. Admins enter a valid IANA time zone name in "Settings → General → App time zone" and save, for example `UTC`, `Europe/London` or `America/New_York`.

The time zone is stored in the `timeZone` field of `config/app-config.json`. Older configurations without this field fall back to `Asia/Shanghai`; regular users can see the current global time zone.

These features use the app time zone:

- Dates shown on questions, practice history, exam papers and admin pages.
- The time in default exam titles, export file names and exam date entry.
- Daily and monthly statistics, and grade and semester calculation.

ISO times ending in `Z` in the database and API still represent the same absolute instant and are converted for display. After saving, the current page uses the new time zone and other open pages pick it up after a refresh; saved exam titles are not rewritten.

See the [time zone notes](https://github.com/margrop/wrong-notebook/blob/main/doc/TIME_ZONE.md) for details.

## Permissions and user management

| Role | Main permissions |
| --- | --- |
| Regular user | Manage their own questions, practice, exam papers and preferences; import and export their own data |
| Admin | Global AI and prompt settings, time zone, registration switch, user management and site-wide data import/export |

Admins open the dashboard from "Settings → User Management" to see usage statistics and enable, disable or delete users. Confirm the target and [back up your data](Backup-and-Restore-en) before deleting. When an account is disabled, its password is reset by an admin, or the user changes their password, the server increments `authVersion` so all existing sessions (JWTs) are immediately revoked and signed out.

New sign-ups are off by default, so strangers cannot register and use up your AI quota when the service is reachable from the internet. To create accounts for family members, an admin turns on "Allow New Registrations" under "Settings → User Management" and turns it off again once the accounts exist. The environment variable `ALLOW_REGISTRATION=true` changes the default; a switch saved on the web page takes precedence. Instances that saved settings on the web page before upgrading keep their existing switch. While sign-ups are off, the sign-in page hides "Register now" and asks visitors to contact the administrator.

### Daily AI limit

To keep children from using up your API quota by regenerating explanations and questions, admins can set "Daily AI Limit per User" under "Settings → User Management". The user list also shows how many AI actions each person has used today.

- Counted actions are the AI features a user starts: recognizing questions, re-solving, generating and grading practice questions, figures, LaTeX fixes, GeoGebra, animated explanations (including narration scripts), re-tagging and exam papers. Each action counts once; a whole exam paper or re-tagging a whole notebook also counts once. An answer that matches the reference exactly is marked without the AI and does not count; cloud voice synthesis uses the speech provider's quota and does not count either.
- Mastery evaluation that runs automatically in the background is not counted.
- 0 means unlimited (the default); admins are not limited. The environment variable `AI_DAILY_LIMIT` sets the default; a value saved on the web page takes precedence.
- Counts reset at midnight in the application time zone. Once the limit is reached, AI features show "You have used up today's AI allowance".

### AI concurrency per model

When several people recognize questions or generate explanations at once, a burst of requests is easily rejected by the provider with a 429 rate-limit error. Admins can set "AI Concurrency per Model" under "Settings → User Management":

- AI calls to the same provider, API address and model never exceed the limit at the same time. Further calls wait in a queue and start in order as earlier ones finish; different models are counted separately.
- Values range from 1 to 100, default 5. Lower it when the provider limits strictly (free quotas, trial plans); raise it when calls queue for long without any 429 errors.
- A saved value applies to later calls immediately. The environment variable `AI_CONCURRENCY_LIMIT` sets the default; a value saved on the web page takes precedence.
- The queue enforces bounded waiting capacity and a wait timeout: exceeding either returns HTTP `429` or `503` with a `Retry-After` header so pending requests do not pile up unboundedly; time spent in the queue also counts toward the page's AI timeout.

Fresh installs create the first admin with a one-time setup link (see the [FAQ](FAQ-en)) instead of shipping a default admin with a fixed password. Upgrades keep existing accounts; `scripts/seed-admin.js` only restores the admin role of an existing `admin@localhost` and never creates an account.

## Background tasks and progress

The task entry at the bottom right of the page shows the status of long operations such as recognition, animations, narration scripts, animation voice (cloud voice), re-solving, batch tagging, data import and exam generation. Some batch tasks show processed and failed counts.

The percentage on the entry screen is an estimate by stage (compress, upload, analyze, process, save), not the AI's real progress; the elapsed time shows how long you have been waiting.

Task state is persisted in the SQLite `AsyncOperation` table (retaining finished records for 30 minutes). Navigating away does not stop processing already running on the server; tasks still running during a restart are marked interrupted (shown as failed with "Interrupted by a server restart") and do not auto-resume. Saved questions and exam papers in the database remain the source of truth.

## About, data-flow disclosure and operational metrics

- **Running version**: **Settings → About** and `GET /api/health` display the running version. Include the version, reproduction steps, and redacted error details when reporting issues; never share API keys or full configuration files.
- **AI data-flow disclosure**: **Settings → About** informs every signed-in user which provider and endpoint locality (official cloud, local/LAN endpoint, or custom remote) handle vision, text, and cloud voice requests, noting that a local model endpoint can be configured instead. All uploaded images are re-encoded on the server to strip EXIF/GPS metadata before storage or upstream forwarding; see the [Privacy Policy](https://github.com/margrop/wrong-notebook/blob/main/doc/PRIVACY.en.md).
- **Admin security posture checks** (visible to admins in **Settings → About**): surfaces warnings when `NEXTAUTH_SECRET` uses a weak or default value, HTTPS is not detected, `TRUST_PROXY` is unset behind proxies, public registration is enabled, or `OPENCLAW_AUTH_MODE=apikey` lacks a configured key.
- **Admin operational metrics (`GET /api/admin/metrics`)**: an admin-only read-only endpoint summarizing background job and `AsyncOperation` status ratios (`succeeded` / `failed` / `interrupted` / `unknown`), AI queue saturation, upstream HTTP 429 rate and queue wait percentiles, SQLite foreign-key integrity checks, database file sizes, and human-override rates on parent papers and teacher grading grouped by `AiProvenance` (strictly PII-free).

## Debug logs

When a problem is hard to describe, an admin can export a debug log and send it to the author:

1. Open "Settings → User Management" and turn on "Debug mode" under "Debug Logs" (turning it on clears the previous recording).
2. Reproduce the problem; the panel shows how many entries have been recorded.
3. Click "Export Debug Log" to download `wrong-notebook-debug-<time>.json` and attach it to your issue. You can then turn debug mode off.

Debug mode records every server log, including the `debug` and `trace` levels that `LOG_LEVEL` normally hides (such as AI requests and responses), plus uncaught browser errors from all users. The export also contains the running version, system environment and redacted configuration.

- API keys, passwords, tokens, cookies and similar fields are replaced with `[REDACTED]` on export, and images keep only their type and size. The log may still contain question text and usernames, so review it before sending if you like.
- The log lives only in the server process's memory and keeps at most 5000 entries (the oldest are discarded first). Debug mode turns off 24 hours after it is enabled, and a restart clears the log.
