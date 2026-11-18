# Backup and Restore

Web export now defaults to a **v3 streaming ZIP archive** (`XueJi-backup-*.zip`), suitable for moving complete personal and multi-learner study data. Restoring an entire site still requires backing up the SQLite database, server configuration, and deployment files.

## What each backup covers

| Method | Contents | Use |
| --- | --- | --- |
| Web v3 ZIP backup | `manifest.json`, notebooks, custom tags, learner profiles (children/students), questions, practice records, random exam papers, parent papers/pages/questions, teacher classes/rosters/grading tasks/results, variant runs and stage logs, mastery snapshots, learning paths, AI provenance, deduplicated `media/<sha256>` images, and cloud TTS audio (`tts/*.mp3`) | Moving personal or multi-learner study records across devices or hosts |
| Legacy JSON (v1/v2) | Notebooks, custom tags, questions, practice records, exam papers, variant runs, cloud voices, and user preferences; **excludes** `Learner`, parent papers, teacher grading, mastery snapshots, and learning paths | Importing historical `.json` backups (can also be exported via `GET /api/export?format=json`) |
| Full-site file backup | The complete SQLite database, `config/`, deployment configuration, password hashes, and TLS certificates | Disaster recovery, moving the entire site, preparing a rollback before upgrades |

Web exports **never** include user password hashes or server-side AI credentials, and do not replace a full-site backup. Transient `AiUsage` logs and local `LearnerBackfillAudit` records are excluded from portable backups.

## Web export and import (ZIP v3 and legacy compatibility)

1. Trigger export under **Settings → Danger → Data Management**. The server streams cursor-paged database records into `data/*.ndjson`, splits `data:` images into SHA-256 deduplicated `media/<sha256>` entries and cloud audio into `tts/<id>.mp3`, and appends `manifest.json` with counts and per-entry digests.
2. Regular users can only import backups matching their own account email; admins using **Export All / Import All** preserve per-user ownership mappings across accounts.
3. On import, the server verifies the manifest format version, every entry's byte size and SHA-256 digest, and remaps IDs across learners, parents' papers, teacher grading, variant stage logs, mastery states, and learning paths.
4. **Legacy notes**:
   - v1/v2 `.json` files remain accepted on `/api/import`, with warnings noting that newer multi-learner/grading/path tables are absent from legacy files;
   - The legacy `ReviewSchedule` table is no longer used by application logic (review due dates are computed from `PracticeRecord`). v3 import ignores legacy `ReviewSchedule` rows and returns a notice.
5. Duplicate question matching on import runs within each learner's scope (`{ userId, learnerId }`), recording duplicate hits against that learner without mixing children's histories.
6. **Optional passphrase encryption (AES-256-GCM + scrypt)**:
   - Enter a passphrase before exporting to encrypt all `data/*.ndjson`, `media/*`, and `tts/*.mp3` entries via `POST /api/export`. Each entry uses a fresh 12-byte IV and binds its archive path as GCM AAD; `manifest.json` only stores KDF parameters, the random salt, an encrypted `keyCheck` tag, and ciphertext digests—never the passphrase itself.
   - When exported without a passphrase, the UI and response headers (`X-Backup-Unencrypted-Warning: 1`) remind you that the archive contains student photos and records.
   - Lost passphrases cannot be recovered or reset. Importing an encrypted archive requires the passphrase (via the Settings input, `passphrase` form field, or `X-Backup-Passphrase` header); missing or incorrect passphrases are rejected cleanly before mutating the database.

## Docker full-site backup

This example uses the directory layout from the [deployment guide](Deployment-en). The application uses SQLite **WAL mode** by default (along with `busy_timeout=5000` and `foreign_keys=ON`). Stopping the app before archiving keeps the SQLite main file, its `-wal`/`-shm` files, and the configuration consistent. If you need a single-file copy without `-wal`, run `PRAGMA wal_checkpoint(TRUNCATE)` after stopping writes and then back up the `.db` file.

If the data directory is mounted over NFS / CIFS on a NAS (where shared-memory locks do not work reliably), set `SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` (which automatically switches `synchronous` to `FULL`).

## Daily consistent snapshots and pre-migration backups

- **Daily automatic snapshots**: While running, the server creates a consistent daily snapshot in `backups/daily-snapshot-YYYY-MM-DD.db` via SQLite `VACUUM INTO`, keeping the latest 7 files by default (configurable with `DAILY_SNAPSHOT_RETENTION`). The last success timestamp appears under **Settings → Danger → Data Management**, and failures show a banner on the home page. Docker deployments that already snapshot volumes can disable it with `DAILY_SNAPSHOT_ENABLED=false`.
- **Pre-migration backups**: The package launcher (npm / Desktop / fnOS) and Docker entrypoint run a WAL checkpoint and back up existing databases to `backups/pre-migrate-*` (keeping the latest 3) before running `prisma migrate deploy`, refusing to start and printing restore instructions if a migration fails.
- **Admin system initialization (factory reset)**: At the bottom of **Settings → Danger**, after two-step confirmation (dialog plus typing `RESET`), the server flushes queued background tasks and clears all business tables, other user accounts, and disk TTS/recovery caches in one transaction—preserving only the current admin account and the `isSystem: true` system knowledge-point tree.

Run in the deployment directory:

```bash
mkdir -p backups
docker compose stop wrong-notebook
backup_file="backups/wrong-notebook-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$backup_file" data config docker-compose.yml .env
docker compose start wrong-notebook
tar -tzf "$backup_file"
```

If the backup fails, do not continue with the upgrade; fix the cause and confirm the service is back first. When using the built-in HTTPS, add `certs/` to the archive, along with any other deployment files.

Backups may contain question images, user profiles, password hashes and AI credentials. Restrict access, keep them in a separate location, check that the archive can be read, and verify the restore process in an isolated environment.

## Restore the whole site

1. Confirm the backup time, source version and archive contents; keep another copy of the current data and configuration.
2. Stop the app so nothing is written to the database during the restore.
3. Unpack and check the backup in a separate directory, then restore `data/`, `config/` and the required deployment files.
4. Prefer the image version that matches the backup, and keep the correct mount paths and `NEXTAUTH_SECRET`.
5. After starting, check `/api/health`, then sign in and check users, questions, tags, answer history and exam papers.

Do not switch an old database back and forth between incompatible versions. When an upgrade is needed, run the [upgrade steps](Deployment-en) separately after the restore has been verified.

## Backups when running from source

The default SQLite file is `prisma/dev.db`; the actual location is decided by `DATABASE_URL`. Stop the service, then back up the directory holding the actual database, `config/`, `.env` and the version information. When restoring, use the matching code and dependencies, and run the formal migrations if needed.

Sources: [export](https://github.com/margrop/wrong-notebook/blob/main/src/app/api/export/route.ts) · [v3 backup engine](https://github.com/margrop/wrong-notebook/blob/main/src/lib/backup/export-v3.ts) · [import](https://github.com/margrop/wrong-notebook/blob/main/src/app/api/import/route.ts) · [data model](https://github.com/margrop/wrong-notebook/blob/main/prisma/schema.prisma).
