#!/bin/sh
set -e

# Define paths
SOURCE_DB="/app/prisma/dev.db"
TARGET_DB="/app/data/dev.db"
SEED_MARKER="/app/data/.seed_completed"
VERSION_FILE="/app/data/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
SEED_ADMIN_SCRIPT="/app/dist-scripts/scripts/seed-admin.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# Fix permissions for data and config directories
chown -R nextjs:nodejs /app/data /app/config

# Remember whether this is an existing installation before copying seed data.
DB_ALREADY_EXISTS=false
# Check if the persistent database exists
if [ ! -s "$TARGET_DB" ]; then
    echo "[Entrypoint] Initializing database..."
    if [ -f "$SOURCE_DB" ]; then
        echo "[Entrypoint] Copying pre-packaged database from $SOURCE_DB to $TARGET_DB"
        cp "$SOURCE_DB" "$TARGET_DB"
        # Ensure correct permissions
        chown nextjs:nodejs "$TARGET_DB"
        # Mark as seeded since pre-packaged DB includes seed data
        touch "$SEED_MARKER"
        # Record initial version
        echo "$CURRENT_VERSION" > "$VERSION_FILE"
    else
        echo "[Entrypoint] Source database not found at $SOURCE_DB. Initializing with migrations."
    fi
else
    DB_ALREADY_EXISTS=true
    echo "[Entrypoint] Database already exists at $TARGET_DB."
fi

# Check for version upgrade
PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    PREVIOUS_VERSION=$(cat "$VERSION_FILE")
fi

# Backup existing database before running migrations (pure Node WAL checkpoint + copy, keeping latest 3)
BACKUP_PATH=""
if [ "$DB_ALREADY_EXISTS" = "true" ]; then
    echo "[Entrypoint] Creating pre-migration backup..."
    BACKUP_PATH=$(node -e '
const fs = require("fs");
const path = require("path");
const dbFile = process.argv[1];
const version = (process.argv[2] || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
const backupsDir = "/app/data/backups";
fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
const walFile = dbFile + "-wal";
const shmFile = dbFile + "-shm";
const hasWal = () => fs.existsSync(walFile) && fs.statSync(walFile).size > 0;
(async () => {
  if (hasWal()) {
    try {
      const { PrismaClient } = require("/app/node_modules/@prisma/client");
      const client = new PrismaClient({ datasources: { db: { url: "file:" + dbFile + "?connection_limit=1" } } });
      try {
        await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
        await client.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
      } finally {
        await client.$disconnect();
      }
    } catch (err) {
      console.error("[Entrypoint] WAL checkpoint warning:", err.message);
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = "pre-migrate-" + version + "-" + ts;
  let target;
  if (!hasWal()) {
    const tmp = path.join(backupsDir, "." + baseName + "." + process.pid + ".tmp");
    fs.copyFileSync(dbFile, tmp);
    fs.chmodSync(tmp, 0o600);
    target = path.join(backupsDir, baseName + ".db");
    fs.renameSync(tmp, target);
  } else {
    const tmpDir = path.join(backupsDir, "." + baseName + "." + process.pid + ".tmp");
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    for (const src of [dbFile, walFile, shmFile]) {
      if (fs.existsSync(src)) {
        const dest = path.join(tmpDir, path.basename(src));
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, 0o600);
      }
    }
    fs.writeFileSync(path.join(tmpDir, "RECOVERY.txt"), "Stop container and restore all .db/.db-wal/.db-shm files back to /app/data/ before downgrading image.\n", { mode: 0o600 });
    target = path.join(backupsDir, baseName);
    fs.renameSync(tmpDir, target);
  }
  const entries = fs.readdirSync(backupsDir).filter((n) => n.startsWith("pre-migrate-") && !n.endsWith(".tmp")).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - 3))) {
    fs.rmSync(path.join(backupsDir, stale), { recursive: true, force: true });
  }
  process.stdout.write(target);
})().catch((e) => { console.error(e); process.exit(1); });
' "$TARGET_DB" "$CURRENT_VERSION")
    echo "[Entrypoint] Pre-migration backup saved at: $BACKUP_PATH"
fi

# Run migrations to ensure DB schema is available and up to date.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app
if ! $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma; then
    echo "[Entrypoint] Database migration failed; refusing to start." >&2
    if [ -n "$BACKUP_PATH" ]; then
        echo "[Entrypoint] Restore database from pre-migration backup: $BACKUP_PATH" >&2
    fi
    exit 1
fi
echo "[Entrypoint] Migrations completed successfully."

# Bootstrap new installations; deployments preserve existing account state.
if [ "$DB_ALREADY_EXISTS" = "true" ] && [ "${PRESERVE_EXISTING_DATA:-false}" = "true" ]; then
    echo "[Entrypoint] Preserving existing accounts; skipping admin seed."
else
    echo "[Entrypoint] Restoring admin role for the existing default admin, if any..."
    node "$SEED_ADMIN_SCRIPT"
fi
touch "$SEED_MARKER" 2>/dev/null

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    if [ "$DB_ALREADY_EXISTS" = "true" ] && [ "${PRESERVE_EXISTING_DATA:-false}" = "true" ]; then
        echo "[Entrypoint] Preserving existing system tags and associations."
    else
        echo "[Entrypoint] Rebuilding system tags to sync with new version..."
        node "$REBUILD_TAGS_SCRIPT"
    fi
    # Update version marker
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"
    
    # 确保证书目录存在
    mkdir -p "$CERT_DIR"
    chown nextjs:nodejs "$CERT_DIR"
    
    # 检查证书是否存在
    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."
        
        # 获取证书 CN（优先使用环境变量，否则使用 localhost）
        CERT_CN="${CERT_DOMAIN:-localhost}"
        
        # 生成自签名证书（有效期 10 年）
        openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
    fi
    
    # 启动 HTTPS 代理
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 443)..."
        su-exec nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec su-exec nextjs:nodejs "$@"
