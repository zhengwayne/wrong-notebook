# Optimization Roadmap (Final)

[中文](optimization-roadmap.md)

| Item | Details |
| --- | --- |
| Finalized | 2026-11-17 |
| Code baseline | Branch `feat/frontend-refactor-learning-path`, commit `0ee3ffd` |
| Sources | Merged from three review drafts: the original review (R01–R16, detailed designs D1–D8), the assessment plan (OPT-01–OPT-18), and the extension design (E1–E7). The drafts are not committed |
| Scope | Design only, no code changes. All findings were checked against the source, but figures marked "measured by the assessment plan" (coverage, file counts, timings) were not re-measured during the merge |
| Status | Confirmed and used as the basis for implementation. If implementation turns up facts that contradict this document, update this document before changing code |

## 1. Summary

- **The architecture stays.** Keep the self-hosted Next.js monolith with Prisma and SQLite. No microservices, Redis, PostgreSQL or vector database. Every issue can be solved inside the current architecture.
- **The default deployment is a family single account**: one parent account with several children (`Learner`), running on a LAN or NAS. The ordering principle is: first make sure data is never lost and AI results are accurate, then isolate data between children. Cross-account hardening comes later, but must be pulled forward when any [early trigger](#32-early-triggers) applies.
- **There is only one P0**: production stdout logs contain full prompts and student answers (`logger.box`). Everything else is re-rated in section 4.
- **Delivery blocker**: a test file on the current branch contains a local user directory, so the public history check fails. This is not rated as a security issue; it goes first in Batch 0.
- **The roadmap has Batches 0–G.** Batches 0–F total about 37–51 person-days. Stopping after Batch D (about 22–30 person-days) already covers the main risks of the family single-account deployment.

## 2. Confirmed decisions

| # | Decision | Outcome | Impact on implementation |
| --- | --- | --- | --- |
| 1 | Default deployment | Family single account (one parent account, possibly several children, LAN/NAS) | Order by section 6; pull hardening forward per section 3.2 when multiple accounts, public access or Openclaw appear |
| 2 | Priority calibration | The only P0 is production logs leaking prompts and student answers; the `subjectId` IDOR and R02 are P1; admin endpoints returning the password hash or plaintext keys are P2 | Whenever an OPT number is cited, the rating in section 5 of this document applies |
| 3 | AI evaluation data | Synthetic and public questions only; never children's real photos or handwriting | `eval/datasets/` may go into the public repository. Handwriting and photo scenarios are covered synthetically: print public questions, write them by hand, photograph them, then add shadows, skew, transparent-background screenshots and so on. The dataset README states each sample's author and license |
| 4 | Per-item review algorithm | Add an FSRS-style per-item memory model behind an `algorithmVersion` switch; the default stays `ebbinghaus-v1` | Try it at home first and compare recall accuracy on due items before deciding whether to change the default. Changing the default is a separate commit that also updates both READMEs and the Wiki |
| 5 | Image processing on the standalone Android build | Verify `@img/sharp-wasm32` first (about 0.5 person-days) | If it works, keep a single server-side cropping path and drop the x64 binary from the package; otherwise fall back to frontend Canvas. Record the outcome in OPT-13 either way |
| 6 | Archiving | Merge the three drafts into this document (`doc/design/optimization-roadmap.md` plus this English version), committed on its own | The drafts stay local and are not committed |

## 3. Deployment forms and risk model

### 3.1 Primary risk by deployment form

| Deployment form | Primary risks | Handle first |
| --- | --- | --- |
| Family single account, LAN/NAS (default) | Data loss, failed migrations, wrong AI grading, data mixing between children | OPT-22 daily snapshots, OPT-08 pre-migration backup, OPT-04/09/19 AI quality, OPT-07 child isolation, OPT-11a backup v3 |
| Family with several accounts, or exposed to the internet | Unauthorized access, sessions that cannot be revoked, brute-force login | D1a session check, `subjectId` IDOR, R02, `TRUST_PROXY`, HTTPS |
| Teacher with several classes | Students with the same name mixed up, duplicate imports | Teacher part of OPT-07 (R07), OPT-10 grading confirmation (R11) |
| Standalone Android build | Lost device, no backup, broken `sharp` | OPT-22, OPT-13, OPT-20 backup encryption |

Note that a single account is not a single learner. When one parent account has several children, data mixing between children (duplicate detection, statistics, review, clearing) is the most likely correctness problem in this form, which is why Batch C is dedicated to it.

### 3.2 Early triggers

If any of the following happens, move the D1a session check, the `subjectId` IDOR fix and `TRUST_PROXY` from Batch F ahead of the current batch (about 1.5 person-days for all three):

- open registration, or a second account is added;
- access over the internet or through a reverse proxy;
- the Openclaw integration is enabled.

Detect these states on the "System information" page in settings and show a warning (for example "Accessed over the internet without HTTPS"). This works better than documentation alone.

## 4. Priority definitions and findings register

### 4.1 Rating criteria

| Rating | Meaning |
| --- | --- |
| P0 | Happens under the default configuration with no preconditions and leaks data or causes unrecoverable loss; handle immediately |
| P1 | A security issue that needs some precondition to exploit, or a correctness issue that directly causes wrong data, data loss or broken core features |
| P2 | Defense in depth, issues where the caller already has high privileges, or experience, performance and maintainability issues |
| Delivery blocker | Not a security or feature issue, but it blocks pushes, releases or CI; scheduled first |

### 4.2 Main findings (by rating)

The table lists only findings that affect scheduling; full evidence is in each OPT entry. The last column says whether the issue needs early handling in the family single-account form.

| Rating | Finding | Location | Family single account |
| --- | --- | --- | --- |
| P0 | In production, `logger.box` writes full system prompts, student answers and raw responses to stdout as JSON, which ends up in Docker or NAS logs | [src/lib/logger.ts](../../src/lib/logger.ts), all four AI providers | Early |
| Delivery blocker | A unit test contains a local user directory; `check-public-history.py` fails and the branch's `publication-check` keeps failing | `src/__tests__/unit/user-data-dir.test.ts` lines 24 and 32 | Early |
| P1 | The `variantPipelineEnabled` preference is not saved (R08) | [src/app/api/user/route.ts](../../src/app/api/user/route.ts) | Early |
| P1 | Knowledge-point tags for Chinese, history, geography and politics are all filtered out; `plausibleSubjectsForGrade(null)` misses middle- and high-school physics, chemistry and biology | [src/lib/ai/knowledge-points.ts](../../src/lib/ai/knowledge-points.ts) | Early |
| P1 | `extractJsonObject` silently corrupts or fails on single LaTeX backslashes (`\frac`, `\times`, `\neq` and so on); when parsing several questions, one broken question is silently dropped | `src/lib/ai/schema.ts`, `src/lib/ai/parse-analyze.ts` | Early |
| P1 | Variant answer comparison and verification accept wrong results: commas are always read as "or", the constant equation `1=1` passes, `2x` is not handled, and the constant `e` is treated as a variable (R04) | [src/lib/variant/verify.ts](../../src/lib/variant/verify.ts) | Early |
| P1 | SQLite has no PRAGMAs set (`journal_mode=delete`, `busy_timeout=0`, `foreign_keys=0`); `migrate-tags` omits `tx` inside a transaction | `src/lib/prisma.ts`, `src/app/api/admin/migrate-tags/route.ts` | Early |
| P1 | No automatic backup before migrations; the formal migrations for `ErrorItem` and `PracticeRecord` lack the `learnerId` foreign key (R06) | `packaging/runtime/launcher.js`, `prisma/migrations/` | Early |
| P1 | Duplicate detection, statistics, review and clearing are not scoped per child; the child count limit has a race; deleting a child is not atomic (R03, R12) | Duplicate detection and learner services in `src/lib/`, `src/app/api/stats/` and others | Early |
| P1 | JSON backup misses new tables and `VariantRun.stages`; `system-reset` misses new tables (R05) | `src/app/api/export`, `src/app/api/import`, `src/app/api/admin/system-reset` | Early |
| P1 | The standalone Android build bundles x64 `sharp`, so exam-paper cropping silently fails on arm64 devices | `scripts/package/android-runtime.mjs` | Early (Android users) |
| P1 | Transparent PNGs turn black when converted to JPEG; images up to 1MB skip resizing and orientation fixes | `src/lib/image-utils.ts` | Early |
| P1 | Tests occasionally time out under heavy load; `persona.test.ts` regenerates the Prisma Client mid-run and races; the three release paths (release, packages, docker-build) have no same-SHA gate (R16) | `vitest.config.mts`, `.github/workflows/` | Early |
| P1 | `subjectId` ownership is not checked, so items can be written into another account's notebook | [src/app/api/error-items/route.ts](../../src/app/api/error-items/route.ts) | Later (earlier on a trigger) |
| P1 | The response-recovery endpoint does not check ownership (R02); old JWTs stay valid after an account is disabled or its password changed (R01) | `src/lib/current-user.ts`, `src/lib/auth.ts`, `recoverable-response` | Later |
| P2 | Admin endpoints return the password hash; `/api/settings` returns plaintext keys | `src/app/api/admin/users/[id]`, `src/app/api/settings` | Later |
| P2 | `app-config.json` is not `0600` and writes are not atomic; `auth.ts` hard-codes `debug: true`; login emails are not normalized | `src/lib/config.ts`, `src/lib/auth.ts` | Partly early (cheap, in Batch 0) |
| P2 | The Openclaw endpoint lacks an `isActive` check, compares keys in non-constant time, and squeezes the per-image timeout too low | `src/app/api/openclaw/batch-upload/route.ts` | Later (earlier when Openclaw is enabled) |
| P2 | Rate limiting trusts the spoofable `CF-Connecting-IP` | `src/lib/rate-limit.ts` | Later |

The assessment plan overstated "Openclaw authentication silently downgrades". When no API key is configured, the endpoint falls back to username and password checks; it does not skip authentication. The real problems are the missing `isActive` check, no rate limiting, and matching users by a non-unique field.

## 5. Optimization items

Numbering follows the assessment plan's OPT-01–OPT-18, with new items OPT-19–OPT-22 (from extension designs E1, E2, E5 and E6). E3 is merged into OPT-12, E7 into OPT-09, and E4 is section 3. Each item lists its rating, batch, key points, acceptance criteria and dependencies.

### OPT-01 · Split hotfixes (Batch 0 and Batch F)

The assessment plan grouped several migration-free point fixes together. Per decision 1 they are split in two:

**Batch 0 (independent of deployment form, cheap)** (Done: `ec8ee57`, `3ecc30f`, `b2b6226`)

1. Replace the local user directory in the test file with an example path allowed by `check-public-history.py` (`/Users/example/...`), and replace the user name on line 32 as well. [Delivery blocker] (Done: `ec8ee57`)
2. `PATCH /api/user` handles `variantPipelineEnabled` and returns the value actually saved on the server (R08). [P1] (Done: `3ecc30f`)
3. `src/lib/config.ts` writes with `{ mode: 0o600 }`; within one synchronous section it re-reads the file from disk, merges, writes a temporary file and replaces atomically with `renameSync`; `generateId()` uses `crypto.randomUUID()`. [P2] (Done: `b2b6226`)
4. Remove the hard-coded `debug: true` from `src/lib/auth.ts` in favor of `NEXTAUTH_DEBUG === 'true'`. [P2] (Done: `b2b6226`)
5. Add `*.db.bak-*`, `*.db.live-migrated-*` and `*.log.bak-*` to `.gitignore` (see OPT-18). (Done: `ec8ee57`)

**Batch F (cross-account hardening)**

- Check `subjectId` ownership (`where: { id: subjectId, userId }`, 404 across users) and fix `error-items/[id]` so an empty string can unlink the subject. [P1]
- Define `USER_SAFE_SELECT` so the admin user endpoints return only safe fields; validate `isActive` with zod. [P2]
- Openclaw: reject when no key is configured; compare with `crypto.timingSafeEqual`; check `isActive` on every path; set a floor on the per-image timeout (or a separate `OPENCLAW_IMAGE_TIMEOUT`). [P2]
- Normalize login emails with `.trim().toLowerCase()` while still accepting legacy mixed-case accounts; have `https-server.js` forward `x-forwarded-proto` and `x-forwarded-for`. [P2]

**Acceptance**: `check-public-history.py HEAD` reports only the historical object (see OPT-18); the preference survives a refresh; `app-config.json` is `0600` on POSIX; the Batch F part follows the assessment plan's acceptance items.

### OPT-02 · Unified auth actor and `defineApiRoute` wrapper (P1/P2, Batch F)

- **D1a session check (P1, about 1 person-day)**: `getCurrentUser` and the `jwt` callback look up the current `isActive` and `role` by the stable `userId`. No migration is needed; it is the first thing pulled forward when a section 3.2 trigger applies.
- **Full design**: add `authVersion` to `User` (incremented inside the transaction on password change, disable or demotion); `src/lib/server/actor.ts` provides `requireActor()` / `requireAdminActor()`; on invalidation return `401 SESSION_REVOKED | ACCOUNT_DISABLED`, and the frontend signs out after debouncing (together with OPT-15).
- **Wrapper**: `defineApiRoute({ auth, maxBodyBytes, bodySchema }, handler)`. It limits the body by bytes actually read (it does not trust `Content-Length`) and injects `requestId` and `userId` through `AsyncLocalStorage`. It is a higher-order function on the Node runtime, not `middleware.ts` (Edge Runtime does not work with Prisma). Routes are **migrated module by module across batches**, tracked by OPT-21's route inventory test, rather than changing about 100 routes at once.
- **Settings masking (P2)**: keep the server's existing `'********'` mask convention and extract a shared mask/unmask module. `GET`/`POST /api/settings` mask every provider key before responding; `/api/ai/models` and `/api/ai/test` read the real key on the server when they receive the mask. One regression must be handled: right after turning off "same as multimodal", while `textAi` is not yet saved, testing the connection and then saving must not turn the real key into an empty string. The frontend must pass `role` and the OpenAI `instanceId` to the connection test.
- **Outbound requests**: `/api/ai/models` and `/api/ai/test` allow only `http:`/`https:`, reject the link-local range and the unspecified address, keep LAN addresses (for Ollama and vLLM), use a 15-second timeout and forbid redirects.
- **Three-state `TRUST_PROXY`**: by default do not trust `CF-Connecting-IP` (read it only when `TRUST_PROXY=cloudflare`); with `true`, take the trusted last hop per `TRUSTED_PROXY_HOPS`; with `false`, ignore all proxy headers.
- **Input hardening**: `originalImageUrl` accepts only an empty string or `data:image/(png|jpeg|webp|gif);base64,...` (done together with OPT-20's `normalizeImage()`); `logs/frontend` gets a field allowlist and a size limit.

**Acceptance**: after disabling an account or changing its password, old JWTs get 401 and the frontend signs out; an oversized chunked body gets 413; a spoofed `CF-Connecting-IP` cannot bypass rate limiting; `/api/settings` responses contain no plaintext keys, and partial saves and connection tests both work under the mask (including the regression above).

### OPT-03 · Shared AI provider base and log leak prevention (P0 part + P1, Batch 0 + Batch B)

- **Batch 0 [P0] (Done: `1f2edc1`)**: in production, `logger.box` no longer prints content, only provenance and lengths. Debug output requires an explicit environment variable and is truncated and redacted. Add a test asserting that production-mode logs contain no `data:image`, test student names or prompt fragments.
- **Batch B [P1] (Done: `a5fbbb4`)**: extract `base-xml-parser.ts` and `error-normalizer.ts` to unify tag parsing across the four providers (including the fallback for an unclosed `<analysis>`), exception handling in `completeJson`, and the `AI_*` error codes. Add `MAX_TOKENS` truncation retries to Gemini's remaining 13 methods; extend LongCat's `input_image` adapter to every method that takes images; fix Azure's wrong `deployment` argument and the missing `model` in `recognizeGrade`. No external AI SDK.

**Acceptance**: a unit-test matrix of four providers × core methods returns a unified error code, or retries successfully, under 401, 429, timeout and truncation; with `NODE_ENV=production`, logs contain no full prompts or student answers.

### OPT-04 · Tags for all subjects and hardened structured parsing (P1, Batch B, Done: `3a203ae`)

- `SUBJECT_TAG_FIELDS` covers all 9 subjects, with `SUBJECT_DISPLAY_NAMES` as the single source; `plausibleSubjectsForGrade(null)` returns every subject; creating and editing items look up tags by `(name, subject)`.
- `extractJsonObject` runs a string-aware repair pass **before the first `JSON.parse`**: it only touches backslashes inside strings; skips already doubled `\\`; keeps `\"`, `\/` and valid `\uXXXX`; and for `\b`, `\f`, `\n`, `\r` and `\t`, which are valid escapes that would silently become control characters, it doubles the backslash only when a known LaTeX command name follows. `\n` matches only commands such as `neq`, `nabla` and `notin`, so normal line breaks are untouched; the `\t` word list excludes `to` to avoid rewriting tab-separated text. A second pass (trailing commas, raw newlines inside strings) runs only if the first parse still fails.
- `parseAnalyzeResponse` returns `{ items, failedCount }`; failed questions are logged at `warn` and reported to the frontend.

**Acceptance**: tag filtering returns non-empty results for all 9 subjects; `\frac{1}{2}`, `\times 2`, `\begin{aligned}`, `\binom{4}{2}`, `\neq 0`, `\right)` and `\sqrt{2}` parse losslessly, an already doubled `\\frac` is left alone, and `解：\n第一步` keeps a real newline; when one of several questions is broken, the rest are returned with `failedCount=1`. These cases also go into OPT-19's datasets.

### OPT-05 · Test isolation and release gates (P1, Batch A, Done: `5d9e4e6`)

> Note: `scripts/check-migration-drift.mjs` is now wired into CI and `scripts/ci.sh`; the pre-existing `ErrorItem`/`PracticeRecord` foreign-key drift will reach zero after Batch C's OPT-08 foreign-key migration.

- Vitest 5 removed `environmentMatchGlobs`; use `test.projects` instead: a `dom` project (29 `.test.tsx` files plus 6 DOM-dependent `.test.ts` files) and a `node` project (all other unit and integration tests). The assessment plan measured jsdom setups dropping from 186 to 35. Guard the `localStorage` mock in `src/__tests__/setup.ts` with `typeof window`.
- Remove the runtime `prisma generate` call in `persona.test.ts` (or write to a separate temporary directory) to stop the Prisma Client initialization errors caused by concurrent regeneration.
- The `tests/publication` tests explicitly set `core.excludesfile` to the null device so a developer's global gitignore does not affect them.
- CI: build the E2E database with `prisma migrate deploy`; add `prisma migrate diff --exit-code` to catch migration drift; add `tsc --noEmit` to `scripts/ci.sh` and run coverage there.
- Release gate: extract a shared `verify-ci-gate` action. When a `v*` tag is pushed, `release.yml`, `packages.yml` and the `docker-build` job in `ci.yml` all require a completed `ci.yml` run for the same SHA in which every required job concluded `success` (explicitly rejecting `skipped`, because a tag push also produces a run with skipped tests).

**Acceptance**: `tsc --noEmit` passes; `npm run test:unit` exits 0 five times in a row; full concurrent runs no longer hit Prisma initialization errors; when only a skipped run exists and no green one, all three release paths refuse to publish; schema changes without a migration are caught by CI.

### OPT-06 · SQLite engine settings and transaction discipline (P1, Batch A, Done: `150ac2f`)

Implement in order, to avoid deadlocks from a missing `tx` under a single-connection pool:

1. **Fix transaction signatures first**: pass `tx` in `migrate-tags`; remove the `= prisma` default parameters in `tag-recognition.ts` and `notebook-resolver.ts` so data-access functions require an explicit `db`. OPT-21's ESLint rule forbids referencing the global `prisma` inside a `$transaction` callback.
2. **Then unify connections**: in `src/lib/prisma.ts`, inject `connection_limit=1` into `file:` URLs that do not declare one and set PRAGMAs when connecting; align `launcher.js` and `docker-entrypoint.sh`.
3. **Configurable journal mode**: an allowlisted `SQLITE_JOURNAL_MODE`, defaulting to `WAL` + `synchronous=NORMAL` + `busy_timeout=5000` + `foreign_keys=ON`. NFS/CIFS volumes on a NAS can use `DELETE` or `TRUNCATE`, which automatically switches to `synchronous=FULL`. Update `.env.example` and the backup Wiki page.

**Acceptance**: PRAGMAs measured after startup match the configuration; 10 concurrent reads plus 3 concurrent writes produce no `SQLITE_BUSY`; the `migrate-tags` integration test passes.

### OPT-07 · Learner scope isolation and profile management (P1, Batch C + Batch F)

- **Batch C (between children, Done: `bea3a21`)**: `LearningScope = { userId, learnerId }` covers duplicate detection, repeated practice, statistics, clearing, review and the Openclaw endpoint (R03). Creating a child checks the count limit atomically in a transaction. Deleting a child archives it by default (`archivedAt`), or hard-deletes all related data in a single transaction (R12).
- **Batch F (teachers, R07)**: stop matching notebooks by name or merging with `OR`; new writes link strictly by `learnerId` / `gradingStudentId`. Fix historical ownership with the original review's D2 process (read-only inventory, export an ambiguity list, auto-backfill only unambiguous cases, manual confirmation for ambiguous ones, audit log).

**Acceptance**: with two accounts, two children each, and same-name students across classes, entry, duplicate detection, statistics, review and clearing are fully isolated; at most 3 of 10 concurrent create requests succeed; injecting an error mid-deletion leaves no half-finished data. Depends on OPT-06 and the OPT-08 foreign-key migration.

### OPT-08 · Pre-migration backup and foreign-key migration (P1, Batch A + Batch C, Done: `d45ccda`, `0812330`)

- **Batch A: automatic pre-migration backup and startup protection (Done: `d45ccda`).** In `launcher.js`'s `prepare()`, before `migrate deploy` and before the server starts: if the `-wal` file is non-empty, open a temporary connection with the bundled `@prisma/client` and run `wal_checkpoint(TRUNCATE)` (first copy `PRISMA_QUERY_ENGINE_LIBRARY` into `process.env`, pass the database URL explicitly, disconnect in `finally`). Then atomically copy the `.db` to `backups/pre-migrate-<version>-<ts>.db`, keeping the latest 3. If `-wal` could not be emptied, copy `.db`, `-wal` and `-shm` together into a separate directory with recovery notes. If the migration fails, print recovery instructions and refuse to start. Give `applyLearnerBackfill` in `instrumentation.ts` an idempotent completion marker so it no longer runs on every cold start. Fix the fnOS install callback swallowing errors, and add a backup to the upgrade callback.
- **Batch C: foreign-key migration (Done: `0812330`).** Run the read-only legacy database audit (`scripts/audit-learner-foreign-keys.mjs`) first and unlink orphaned `learnerId` values safely (recorded in `LearnerBackfillAudit`), then rebuild `ErrorItem` and `PracticeRecord` with `PRAGMA defer_foreign_keys=ON`, keeping all columns and indexes and adding `ON DELETE SET NULL` foreign keys (R06), reducing migration drift to zero.

**Acceptance**: on a legacy sample database with 10,000 items and a non-empty `-wal`, a complete backup is produced automatically (including committed transactions in `-wal`); after migrating, `prisma migrate diff` exits 0 and `PRAGMA foreign_key_check` is empty; `/api/health` is ready within 15 seconds of a cold start. Roll back with the pre-migration backup plus the previous installer, never with a column-dropping down migration.

### OPT-09 · Variant pipeline and math verification (P1, Batch B; includes E7, Done: `448ffd9`)

- Inject the shared question, LaTeX and SVG rules into the variant prompts; `variant/pipeline.ts` calls `normalizeGeneratedQuestion` to block multiple-choice questions and question numbers or scores; always call `sanitizeFigureSvg` before writing or copying.
- In `svg-animation.ts`, `buildSvgAnimationDocument` calls `sanitizeSvgAnimation` before building HTML. Because extraction takes everything from the first `<svg` to the last `</svg>`, a payload may smuggle `</body>` or `</html>` in between; reject such structural tags outright. If stripping is chosen instead, strip in a loop until nothing changes, so nested constructs like `</bo</body>dy>` cannot reassemble. The frontend currently renders SVG through `<img src=data:...>`, so scripts do not execute directly; this item is defense in depth and protects export scenarios.
- Parse answers as `scalar | tuple | set | text` and stop reading every comma as "or" (tuples compare by position, sets must match in both directions, multi-part questions match by part number); `verifyComputable` checks both that the computed result matches `expected` and that `expected` matches `answerText` (R04).
- `equationHolds`: support implicit multiplication (`2x` → `2*x`); require at least one free variable (rejecting `1=1`); substitute multi-letter variables by name; **never substitute the constant `e` as a variable** (E7). In `verifyComputable`, the numeric branch and the general branch produce identical results, so the numeric type is effectively not handled separately; fix that too (E7). Never mark a result verified without `difficultyConsistent === true` or the core evidence.

**Acceptance**: all counterexamples from the original review's D4 (missing roots, different coordinates, `1=1`, `2x=6`, `expected` contradicting `answerText`, skipped difficulty check) plus the constant-`e` case pass and are added to `eval/datasets/verify/`; variants containing A/B/C/D options or `<script>` are rejected or sanitized; SVG payloads containing `</body><script>`, `onload` or `javascript:` cannot escape.

### OPT-10 · Grading confirmation races and a unified job table (P2, Batch F)

- Parent and teacher grading confirmation claims the state with a conditional update inside a short transaction (`updateMany` conditioned on `status` and `version`), plus a `SourceImport(userId, sourceKind, sourceQuestionId)` unique constraint against duplicate imports. Slow image cropping runs outside the transaction, and the source version is re-checked before committing, returning 409 on conflict (R11).
- One `AsyncOperation` table replaces the original review's D3 idempotency table, the current in-memory `recoverable-response` cache and `background-tasks` (retiring `config/background-tasks.json`): `(userId, kind, idempotencyKey)` + `requestHash`; the same key with the same body reuses the result, the same key with a different body returns 409, and other users get 404 (R02). **The first version has no leases or heartbeats**: with a single instance, marking running jobs `interrupted` on restart is enough.
- `AiDailyQuota(userId, dayKey)` reserves quota atomically; `ai/concurrency.ts` gains a queue limit, queue timeout and cancellation, returning `429/503 + Retry-After` when exceeded (R09, R15).

**Acceptance**: 20 concurrent requests with the same idempotency key write once; 10 concurrent grading confirmations create one set of items; with 1 unit of quota left, only 1 of 20 concurrent requests passes; running jobs have the correct state after a restart. Depends on OPT-02 and OPT-06.

### OPT-11 · Backup v3 (split into 11a and 11b)

**OPT-11a · Streaming ZIP backup v3 (P1, Batch D, Done: `01fec89`, `b02986f`)**

- Reuse the existing `fflate` dependency to export a streaming `.zip`: `manifest.json` (`formatVersion: 3`, per-entity counts, SHA-256 digests) + `data/*.ndjson` + `media/<sha256>`. Export splits `data:` URLs into media files directly, **with no dependency on an Asset table**.
- Add `Learner`, `ParentPaper*`, `Grading*`, `VariantRun.stages`, `KnowledgeMastery` and `LearningPath*`, and fix the hard-coded `VariantRun.userId` in `importAll` (R05). Recomputable derived state (mastery, memory model) is classified separately and can be rebuilt after import.
- The legacy `ReviewSchedule` table is no longer read or written by business code and only appears in export and import. A v3 import converts or ignores old data with a notice, and the next major migration drops the table.
- Keep v1/v2 JSON import compatible and document what the old formats cannot carry. Optional passphrase encryption is covered in OPT-20.
- `admin/system-reset` clears every business table and the disk caches, keeping only the current admin account and the `isSystem: true` system knowledge-point tree.
- Update `src/app/api/export`, `src/app/api/import`, `data-backup.test.ts` and the backup Wiki pages (both languages) together.

**OPT-11b · Asset file storage (P2, Batch G, depending on benchmarks)**: following the original review's D8, decide whether to move images from the database to `${DATA_DIR}/assets/` only after OPT-17 produces benchmark data. If done, migrate gradually (dual reads, verification, keep the old field for a while) and serve them through an authenticated `/api/assets/:id`. The ownership check for `/api/tts/:id` does not depend on assets and goes in Batch F.

**Acceptance (11a)**: exporting a 500MB sample database with images and importing it into an empty one adds less than 150MB to peak RSS; after a v3 round trip, entity counts, learner ownership, `stages` and media SHA-256 all match exactly; after `system-reset`, business tables and caches are empty. Depends on OPT-07 and OPT-08.

### OPT-12 · Unified mastery and per-item memory model (P1 + P2 gradual rollout, Batch E; includes E3)

**12a · Knowledge-point layer (P1)**

- In `mastery-model.ts`, compute `dueAt` from the BKT plus power-law `stabilityDays` at a target retrievability of 0.85, clamped to 1–180 days, replacing the hard-coded interval fallback. This **changes the current "graduation" contract**: instead of stopping review after 7 consecutive correct answers, observed knowledge points are reviewed at least every 180 days, or graduation is defined explicitly as `stabilityDays >= 180 && pKnown >= 0.9`. Update `learning-path.test.ts` accordingly.
- Add stable tie-breakers (`itemId`, `correct`) to evidence sorting so evidence from several items in the same millisecond has a deterministic order.
- Stop the redundant enqueue on item creation and the implicit per-item AI `evaluateMastery` calls after duplicate hits and practice answers; make it user-triggered or a low-frequency batch.
- Remove the logic that adds fake prerequisite edges by pinyin order, keeping only `parentId` tree edges and explicit prerequisites; apply `subjectId` filtering only to the view; make `GET /api/learning-path` read-only; pass `learnerId` in `error-items/route.ts`; load evidence once in `listClassPaths` (R13).

**12b · Per-item memory model (P2, gradual rollout, decision 4)**

- Add `ItemMemory(learnerId, errorItemId, stability, difficulty, lastReviewAt, dueAt, reps, lapses, algorithmVersion)` using FSRS-style update formulas and published default parameters, in plain TypeScript with no new dependency. `algorithmVersion` defaults to `ebbinghaus-v1`.
- Division of labor: BKT's `pKnown` decides what to study (learning path), the memory model decides when to review (today's reviews), and a knowledge point's retrievability is aggregated from its items. The home page and the learning path share `getDueItems(scope, date)` so their due lists never contradict each other.
- `PracticeRecord` is the only source of evidence; all memory state can be recomputed.
- Measuring the effect: compare recall accuracy on due items without increasing review volume; no target number is set in advance.

**Acceptance**: item creation, duplicate hits and practice answers no longer call AI implicitly; same-millisecond evidence sorts deterministically; learning-path tests pass under the new contract; a cached `GET /api/learning-path` performs no database writes; `listClassPaths` issues at least 50% fewer SQL queries for 30 students; today's reviews are correct under both `algorithmVersion` values. Depends on OPT-07.

### OPT-13 · Android `sharp` and multi-platform smoke tests (P1, Batch D, Done: `76aac87`)

1. **`@img/sharp-wasm32` verified**: tested in a Node subprocess blocking all non-`wasm32` native `@img/sharp-*` addons. `@img/sharp-wasm32` (`0.35.5` + `@emnapi/runtime` `1.11.3`) cold-loads in ~93ms, `normalize` takes ~51ms, `autoCrop` ~160ms, and single-region crop ~11ms on a synthetic 1800×2400 exam sheet, adding ~8.9MB for `node_modules/@img/sharp-wasm32`.
2. Single server-side cropping path preserved: `prepareAndroidServerTree` in `android-runtime.mjs` strips all platform `@img/*` packages except `colour` and `sharp-wasm32`, bundles `@img/sharp-wasm32` and `@emnapi/*`, and avoids duplicating crop logic in frontend Canvas.
3. Extended `package-launcher.test.ts` (first-run `seed.db` copy, incremental migrations, pre-migration backup, and `installExternalAliasResolver`), added `android-sharp-runtime.test.ts`, and added unpacked desktop `/api/health` startup, fnOS install/upgrade backup lifecycle, and Android `server.zip` checks in `.github/workflows/packages.yml`.

**Acceptance**: `server.zip` contains no native binaries (`sharp-linux-*` etc.); the standalone Android build runs server-side cropping via `sharp-wasm32` instead of saving whole pages; the unpacked desktop build starts and `/api/health` returns `ok`; wasm verification results recorded here.

### OPT-14 · Lighter first load on the frontend (P2, Batch E)

- `app-shell.tsx` lazy-loads `SettingsDialog` with `next/dynamic`; its tabs render only when active.
- Split translations into `translations/types.ts`, `zh.ts` (bundled statically, keeping synchronous hydration through `useSyncExternalStore` with no flash), `en.ts` (loaded on demand when switching, cached before listeners are notified), and `index.ts` for tests. `api-client.ts` and `question-deduplication.ts` stop importing the whole translation table, so the English dictionary does not leak back into the first-load chunk.
- Wrap `MarkdownRenderer` in `React.memo` and cache `prepareMarkdownMath` with `useMemo`; add `loading.tsx` / `error.tsx` to the main route segments; load print-preview images in batches; split components over 200 lines gradually as features touch them.

**Acceptance**: the home page client chunk contains neither admin components nor the English dictionary; switching to English requests a separate `en` chunk with no hydration errors; `translations.test.ts` passes.

### OPT-15 · Client protocol, image handling and accessibility (P1, Batch E)

- `api-client.ts`: read the response body once and parse by content type, handle 204 separately, and throw a protocol error on unexpected non-JSON; merge the external signal and the timeout with `AbortSignal.any`; set `Content-Type` only when there is a JSON body; handle `SESSION_REVOKED` / `ACCOUNT_DISABLED` (together with OPT-02); add the missing AI error-code mappings in `use-practice-session`.
- `image-utils.ts`: fill a white background before converting to JPEG; check size and orientation for images under 1MB too.
- The settings dialog shares one user-profile context, removing 4 concurrent `GET /api/user` calls; `current-child.ts` is scoped by `userId`; `learn/page.tsx` passes the correct `studentKey` on retry; `<html lang>` defaults to `zh-CN` and follows the language switch; mobile settings tabs get an `aria-label`; notification permission is requested only when the user starts a slow recognition.

**Acceptance**: a transparent PNG compresses to a white background; opening settings sends one `GET /api/user`; unit tests pass for a plain-text 500 in `apiClient`, signal merging and automatic sign-out on session revocation; `html[lang]` follows the language.

### OPT-16 · High-risk coverage and three-role E2E (P2, Batch G)

- Add backend unit and integration tests first: `grading/*` (0% coverage per the assessment plan), parent exam-paper annotation and summary, `error-items/list`, `ai/test`, `admin/migrate-tags`, `admin/system-reset` and the SVG escape cases, then raise the coverage thresholds in `vitest.config.mts` step by step.
- Add 4 Playwright specs (including a 390px mobile viewport): isolation across two accounts, several children and same-name students; a parent uploads a paper, selects regions, reviews and confirms; a teacher grades, confirms and checks the learning path; a v3 backup export, system reset and import round trip.
- The two-tenant test helper and the backup coverage test already exist from OPT-21 in Batch C and are reused here.

**Acceptance**: line coverage of `grading/*` and `error-items/list` is at least 70%; E2E runs on a database built with `migrate deploy` and all specs pass.

### OPT-17 · Performance benchmarks and operational metrics (P2, Batch G)

- A synthetic benchmark script: 1,000 / 10,000 items, 1 / 3 children, 30 / 100 students, multi-page papers; measure p50/p95/p99, SQL counts, RSS and queue wait time for lists, the learning path, import/export and grading confirmation.
- Decide on composite indexes from the measured query plans; do not add indexes up front.
- Operational metrics: job success/failure/unknown ratios, AI provider 429 rate, queue saturation, foreign-key check status, and the share of AI recognition results the user edited by hand, grouped by `provenanceId` (the online signal for OPT-19).

**Acceptance**: the benchmark script is reproducible; p95 for ordinary lists and details is at most 500ms, and at most 1s for the cached learning path (excluding AI time).

### OPT-18 · Public history, workspace hygiene and documentation debt (delivery blocker + P2)

- **Workspace hygiene (Batch 0, Done: `ec8ee57`)**: move local database and log backups out of the repository (anything kept as a migration test sample must first be confirmed to contain no real data); add matching `.gitignore` rules without covering `prisma/migrations/` or test fixtures.
- **Historical object (when merging into `main`)**: the object introduced by commit `48e96ed` is already on the feature branch in the public remote, so adding new commits cannot remove it. Use **path A**: squash when merging into `main`, or rebuild a clean branch from `main`, so `main` contains only clean commits and the pushed feature branch is not rewritten. **Path B** (interactively rebasing `48e96ed..HEAD` and force-pushing) requires separate confirmation from the user.
- **Documentation debt**: `doc/wiki/` still describes the single-user era. Update affected pages with each batch (for example, Batches A and D update the backup and restore page with WAL, snapshots and the v3 scope), and before the features reach `main`, complete the Chinese and English pages and the website for multiple children, parent exam papers, teacher grading, learning paths and multi-platform installation troubleshooting.

**Acceptance**: `git status` shows no local backup files; after the merge, `check-public-history.py main` exits 0; the Wiki in both languages covers the shipped features.

### OPT-19 · AI quality evaluation and provenance (P1, Batch B; from E1, Done: `d67925e`)

OPT-03 and OPT-04 fix behavioral differences between providers, but still cannot tell whether a model or prompt change made things better or worse. The repository has only smoke-test scripts, and the database does not record which provider, model and prompt version produced an AI result.

**Provenance**

```prisma
model AiProvenance {
  id            String   @id @default(cuid())
  task          String   // analyze | grade | exam-read | variant | tag ...
  provider      String   // gemini | openai | azure | anthropic | vendor preset name
  model         String
  promptVersion String   // first 12 hex chars of the hash of the normalized prompt text in prompts.ts
  parserVersion String   // version of the parsing and validation logic
  createdAt     DateTime @default(now())
  @@unique([task, provider, model, promptVersion, parserVersion])
}
```

Identical combinations reuse one row, so writes cost almost nothing. AI-produced records (`ErrorItem`, parent exam-paper questions, grading results, `VariantItem`) get a nullable `provenanceId`; old data is not backfilled. `promptVersion` is computed from `prompts.ts` at build time rather than maintained by hand. Tokens and latency go into OPT-10's usage table and are not counted twice. The new field must be added to export and import (OPT-11a).

**Offline evaluation**

```
eval/
  datasets/{analyze,grading,exam-read}/   # images + human labels; needs a real AI, not run in CI
  datasets/verify/                         # text-only answer-equivalence cases; run in unit tests
  run-eval.ts                              # runs task × provider × model, outputs JSON and Markdown
  baselines/
```

- Data: synthetic and public questions only (decision 3), with metadata stripped before committing; the first batch has 30–50 cases per category.
- Metrics: question-text edit distance, exact answer match rate, tag F1 across 9 subjects (directly validates OPT-04), grading accuracy, **the rate of wrong answers graded as correct** (the error grading must avoid most), JSON parse failure rate, p95 latency and cost per question.
- Rule: every PR that changes `prompts.ts`, a parser or a default model attaches an evaluation report; a drop in a key metric beyond the threshold (initially 2 percentage points) must be explained.

**Acceptance**: `run-eval.ts` produces a report for at least two providers and compares it with the baseline; new AI-produced records carry a `provenanceId`; `datasets/verify/` cases run in `npm run test:unit`.

### OPT-20 · Children's data privacy (P1/P2, Batches B, D, G; from E2)

The users are mostly primary and secondary school students. Today the server stores original images as received; the Openclaw endpoint, for example, builds a raw `data:` URL (`src/app/api/openclaw/batch-upload/route.ts`). GPS and device information in photos is kept indefinitely and spreads through exports.

| Item | Design | Rating | Batch |
| --- | --- | --- | --- |
| Server-side image normalization | Every entry point (recognition, Openclaw, parent exam papers, teacher grading) goes through `normalizeImage()`: decode with sharp, rotate by orientation, **strip all metadata**, cap the longest edge, re-encode; also check the real MIME type and a pixel limit (OPT-02 only limits bytes). Frontend compression is an optimization; the server is the security boundary. The `originalImageUrl` protocol check is done here too | P1 | B (Done: `b2d6a3f`) |
| Backup encryption | ZIP v3 supports optional passphrase encryption (AES-256-GCM with a key derived from the passphrase by scrypt), with the encryption parameters stored in plain text in the manifest; unencrypted exports show a notice | P2 | D (Done: `9cbee2b`) |
| Self-service deletion | `DELETE /api/user`: requires re-entering the password, offers an export first, then deletes all data in one transaction (relying on OPT-08's foreign keys) and writes one audit record with no personal data; admin user deletion reuses the same service | P2 | G |
| Disclosure of data flows | The settings page and `doc/PRIVACY*.md` state that images are sent to the currently configured AI provider, name it, and mention that a local model endpoint can be used instead | P2 | G |

Log redaction is part of OPT-03's Batch 0 work.

**Acceptance**: a test image with GPS data contains no EXIF after entering through any entry point; an encrypted backup cannot be imported without the passphrase and round-trips correctly with it; after self-service deletion, the user's business tables are empty.

### OPT-21 · Regression guardrails (shipped with the matching fix; from E5)

Each guardrail goes into the same commit as the problem it prevents.

| Guardrail | Implementation | Prevents | Batch |
| --- | --- | --- | --- |
| Log assertion test | Production-mode logs contain no `data:image`, test student names or prompt fragments | Log leak regressions | 0 (Done: `1f2edc1`) |
| Preference round-trip test | Generate PATCH→GET round-trip cases from the keys of `userUpdateSchema` | Bugs like R08 | 0 (Done: `3ecc30f`) |
| ESLint transaction rule | Forbid referencing the global `prisma` inside a `$transaction` callback | Missing `tx` from OPT-06 | A (Done: `150ac2f`) |
| Two-tenant test helper | `withTwoTenants()` creates two accounts, two children and same-name students, and asserts that cross-scope access returns 404 | R03, R07, IDOR | C (Done: `bea3a21`) |
| Backup coverage test | Enumerate every model through Prisma DMMF; each must appear on either the "exported" or the "deliberately not exported" list | R05 regressions | C (Done: `f6bb37f`) |
| system-reset coverage test | Also DMMF-based: assert that all business tables are empty after a reset | Missed new tables | D (Done: `01fec89`) |
| Route inventory test | Scan `src/app/api/**/route.ts`, require every exported handler to be wrapped by `defineApiRoute`, and compare with an `api-auth-inventory.json` snapshot; new public routes must be registered explicitly | Bypassed auth | F |
| ESLint session rule | Forbid importing `getServerSession` directly in `src/app/api/**` | R01 regressions | F |

The backup coverage, preference round-trip and system-reset coverage tests are cheap, and they turn the AGENTS.md rule "new fields must be added to export and import" from a convention into a machine check.

### OPT-22 · Daily snapshots (P1, Batch A; from E6, Done: `1c0ab8b`)

OPT-08 backs up only once, before migrating. In addition:

- Create a consistent snapshot every day with `VACUUM INTO` under `backups/` in the data directory, keeping 7 by default (safe in WAL mode too);
- Show the time of the last successful snapshot in settings, and warn on the home page when it fails;
- On by default for the standalone Android build and fnOS; Docker deployments can turn it off with an environment variable (for example when they already snapshot volumes). Add the new variable to `.env.example`.

This is the simplest and most reliable full-site recovery mechanism, and it complements ZIP v3, which targets data migration.

**Acceptance**: only the latest 7 snapshots are kept over time; a snapshot can be opened directly as the database and passes `PRAGMA integrity_check`; a failed snapshot produces a home-page warning.

## 6. Roadmap

Each independent requirement is its own commit; a guardrail ships in the same commit as its fix; every commit must pass tests on its own and include its tests and documentation. Estimates assume one engineer familiar with the project and include tests and documentation updates.

| Batch | Goal | Contents | Estimate (person-days) | Rationale |
| --- | --- | --- | --- | --- |
| **Batch 0 Stop the bleeding** (Done: `ec8ee57`, `3ecc30f`, `b2b6226`, `1f2edc1`) | Restore the public history check, plug the log leak | The Batch 0 part of OPT-01 (test path, R08, `config.ts`, `debug`); OPT-03 log silencing; OPT-18 workspace hygiene; OPT-21 log assertion and preference round-trip tests | 1.5–2 | Cheap with certain payoff, independent of deployment form; without the public history check, every later push is blocked |
| **Batch A Never lose data** (Done: `150ac2f`, `d45ccda`, `1c0ab8b`, `5d9e4e6`) | Families have no ops skills, so recovery comes first | OPT-22 daily snapshots; OPT-08 pre-migration backup and startup protection; OPT-06; OPT-05 | 4–6 | Every later migration relies on this layer |
| **Batch B AI quality** (Done: `3a203ae`, `a5fbbb4`, `448ffd9`, `b2d6a3f`, `d67925e`) | Accurate recognition, tagging and grading | OPT-04; OPT-03 provider consistency; OPT-19 provenance and evaluation; OPT-09 (with E7); OPT-20 `normalizeImage()` | 7–9 | Accuracy is what families notice every day |
| **Batch C Isolation between children** (Done: `0812330`, `bea3a21`, `f6bb37f`) | Correctness for families with several children | OPT-08 foreign-key migration (read-only audit and FK table rebuild); child part of OPT-07; OPT-21 two-tenant helper and backup coverage test | 5–7 | The most likely data mixing under a single account |
| **Batch D Portable backup** (Done: `01fec89`, `b02986f`, `9cbee2b`, `76aac87`) | Moving devices or NAS | OPT-11a (including `ReviewSchedule` handling and system-reset); OPT-20 backup encryption; OPT-13 (wasm verified); OPT-21 system-reset coverage test | 5–7 | The main recovery scenario for families |
| **Batch E Learning effect and experience** | Review and everyday use | OPT-12a; OPT-12b gradual rollout; OPT-15; OPT-14 | 7–10 | Depends on Batch C's learner scope |
| **Batch F Multiple accounts and hardening** | Cross-account security | OPT-02 (D1a first, wrapper migrated module by module); the Batch F part of OPT-01; teacher part of OPT-07; OPT-10; `/api/tts/:id` ownership check; OPT-21 route inventory and session rule | 8–11 | Low risk for a family single account; pulled forward wholly or partly when a section 3.2 trigger applies |
| **Batch G On demand** | Long-term quality | OPT-16; OPT-17; OPT-11b (depending on benchmarks); OPT-20 self-service deletion and data-flow disclosure; OPT-18 documentation debt | TBD | — |

Batches 0–F total about **37–51 person-days**; through Batch D, about **22–30 person-days**. The assessment plan's Batches 0–D came to 24–33.5 person-days. The difference comes mainly from no longer packing OPT-02's route migration into one batch, the new OPT-19–OPT-22, and OPT-12b.

### Dependencies

```
Batch 0 ──► Batch A ──► Batch B
              │
              ├──► OPT-06 ──► OPT-08 foreign keys (Batch C) ──► OPT-07 child part ──► OPT-11a (Batch D)
              │                                                      │
              │                                                      └──► OPT-12a/12b (Batch E)
              └──► OPT-05 gates protect every later batch
OPT-13 wasm verification ──► Android storage path in OPT-11a
OPT-02 D1a ──► full OPT-02 ──► session revocation handling in OPT-10 and OPT-15
OPT-17 benchmarks ──► whether to do OPT-11b and add indexes
```

Batches B and C have no hard dependency on each other and can run in parallel with enough people.

## 7. Implementation conventions

- **Migrations**: every change to `prisma/schema.prisma` uses a formal migration that works with existing data (production runs with `PRESERVE_EXISTING_DATA=true`). Table-rebuilding migrations ship only after OPT-08's pre-migration backup and OPT-22's daily snapshots are in place.
- **Backup fields**: new fields or tables that need backing up (such as `provenanceId`, `ItemMemory`, `AsyncOperation`) are added to export, import and `data-backup.test.ts` at the same time; from Batch C on, the backup coverage test enforces this.
- **AI changes**: change all four providers together, with prompts kept in `prompts.ts`; from Batch B on, attach an OPT-19 evaluation report.
- **Documentation sync**: when features, settings or defaults change, update `README.md`, `README.en.md` and the affected Chinese and English pages in `doc/` and `doc/wiki/`; user-facing changes also update the website project.
- **Maintaining this document**: when an item is done, note the commit next to its entry; when scope or rating changes, update this document first.

## 8. Unverified boundaries and deferred work

**Not re-measured during the merge**

- Coverage figures, test file counts (the 35 / 151 split), jsdom setup counts, component line counts and similar numbers come from the assessment plan's measurements; use fresh measurements at implementation time.
- `@img/sharp-wasm32` (`0.35.5` + `@emnapi/runtime`) loading, normalization, auto-trim, and single-region crop timing and ~8.9MB package footprint have been verified in Node with native `@img/sharp-*` addons blocked; on-device Android wall-clock speed can be re-checked against preview builds.
- WAL behavior on network volumes (NFS/CIFS) was not tested; the default for `SQLITE_JOURNAL_MODE` may need adjusting based on feedback from NAS users.

**Explicitly deferred**

- No Redis, PostgreSQL, message queues or microservices.
- No external FSRS or AI SDK dependency.
- No leases or heartbeats in the first version of `AsyncOperation`; add them if multi-instance deployment appears.
- Asset file storage (OPT-11b) waits for benchmark data.
- No indexes up front; follow OPT-17's query plans.

## 9. Main differences from the drafts

| In the drafts | Final | Reason |
| --- | --- | --- |
| The assessment plan rated OPT-01–OPT-08 as P0 or P0/P1 | Only the log leak stays P0; everything else is re-rated per section 4 | Decision 2 |
| The assessment plan put OPT-02 in Batch A | OPT-02 moves to Batch F, with only D1a pulled forward on a trigger; Batch A becomes "never lose data" | Decision 1 |
| OPT-11 did ZIP v3 and the Asset migration in one step | Split into 11a (ZIP v3, no Asset dependency) and 11b (depending on benchmarks) | The two carry very different risk |
| OPT-10 included leases and heartbeats | Not in the first version | Unnecessary for a single instance |
| OPT-12 changed only the knowledge-point layer | Adds 12b, a per-item memory model rolled out gradually | Decision 4 |
| OPT-13 switched straight to frontend Canvas | Verify `sharp-wasm32` first | Decision 5; avoids two cropping implementations |
| Neither draft covered AI evaluation, children's privacy, guardrails or daily snapshots | New OPT-19–OPT-22 | Extension designs E1, E2, E5, E6 |
| The assessment plan suggested archiving as `doc/ARCHITECTURE_OPTIMIZATION_PLAN.md` | `doc/design/optimization-roadmap.md` plus the English version | Decision 6 |
| Openclaw "authentication silently downgrades" | Rephrased as missing `isActive` check, rate limiting and unique matching | Checked against the source: without a key it falls back to password checks |
