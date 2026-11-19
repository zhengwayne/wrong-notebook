#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export NEXT_TELEMETRY_DISABLED=1
export DATABASE_URL="${DATABASE_URL:-file:./ci.db}"
# 安装前由 npm 校验当前平台锁定依赖的 Node.js 版本范围。
npm ci --engine-strict --no-audit --no-fund
npx --no-install prisma generate
npm run lint
npx --no-install tsc --noEmit --incremental false
node scripts/check-migration-drift.mjs
npm run test:coverage
python3 -m unittest discover -s tests/publication -v
python3 scripts/check-public-history.py HEAD
bash -n scripts/ci.sh
bash -n scripts/build-image.sh
sh -n docker-entrypoint.sh
for f in packaging/runtime/launcher.js packaging/npm/bin/wrong-notebook.js packaging/desktop/main.js scripts/package/build.mjs scripts/check-migration-drift.mjs scripts/verify-ci-gate.mjs scripts/audit-learner-foreign-keys.mjs scripts/start-e2e.js src/lib/legacy-admin-password-hash.mjs; do node --check "$f"; done
for f in packaging/fnos/cmd/*; do bash -n "$f"; done
npm run build
