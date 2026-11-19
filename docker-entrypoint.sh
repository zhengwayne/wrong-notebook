#!/bin/sh
set -e

# Debian 镜像用 gosu，Alpine 镜像用 su-exec。
# 注意：POSIX sh 的 exec 不能调用函数，所以特权降级命令必须放进变量。
# 非 root 身份启动时跳过降权直接执行，允许在只读/非特权容器环境中直接运行。
if [ "$(id -u)" = "0" ]; then
    if command -v gosu >/dev/null 2>&1; then
        DROP_PRIVS=gosu
    elif command -v su-exec >/dev/null 2>&1; then
        DROP_PRIVS=su-exec
    else
        echo "[Entrypoint] gosu/su-exec not found" >&2
        exit 1
    fi
    drop_privs() { "$DROP_PRIVS" nextjs:nodejs "$@"; }
else
    DROP_PRIVS=""
    drop_privs() { "$@"; }
fi
write_version_file() {
    drop_privs sh -c 'printf "%s\n" "$1" > "$2"' -- "$CURRENT_VERSION" "$VERSION_FILE"
}


# Define paths
SOURCE_DB="/app/prisma/dev.db"
TARGET_DB=$(node -e 'process.stdout.write(require("/app/launcher.js").resolveSqliteFile(process.env.DATABASE_URL, "/app/prisma"))')
DB_DIR=$(dirname "$TARGET_DB")
VERSION_FILE="$DB_DIR/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# Fix permissions for data and config directories
if [ "$(id -u)" = "0" ]; then
    chown -R nextjs:nodejs /app/data /app/config
fi
if [ ! -d "$DB_DIR" ]; then
    mkdir -p "$DB_DIR"
    if [ "$(id -u)" = "0" ]; then
        chown nextjs:nodejs "$DB_DIR"
    fi
fi
if ! drop_privs test -w "$DB_DIR"; then
    echo "[Entrypoint] 数据库目录需要为 nextjs 用户提供写权限：$DB_DIR" >&2
    exit 1
fi
for db_file in "$TARGET_DB" "$TARGET_DB-wal" "$TARGET_DB-shm" "$TARGET_DB-journal" "$VERSION_FILE"; do
    if [ -f "$db_file" ] && ! drop_privs test -w "$db_file"; then
        if [ "$(id -u)" = "0" ]; then
            chown nextjs:nodejs "$db_file"
        fi
    fi
done

# Remember whether this is an existing installation before copying seed data.
DB_ALREADY_EXISTS=false
# Check if the persistent database exists
if [ ! -s "$TARGET_DB" ]; then
    echo "[Entrypoint] Initializing database..."
    if [ -f "$SOURCE_DB" ]; then
        echo "[Entrypoint] Copying pre-packaged database from $SOURCE_DB to $TARGET_DB"
        cp "$SOURCE_DB" "$TARGET_DB"
        # Ensure correct permissions
        if [ "$(id -u)" = "0" ]; then
            chown nextjs:nodejs "$TARGET_DB"
        fi
        # Record initial version
        write_version_file
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
elif [ "$DB_DIR" != "/app/data" ] && [ -f "/app/data/.app_version" ]; then
    # 兼容旧版将版本标记写在 /app/data/.app_version 的自定义数据库部署
    PREVIOUS_VERSION=$(cat "/app/data/.app_version")
fi

# Backup existing database before running migrations (pure Node WAL checkpoint + copy, keeping latest 3)
BACKUP_PATH=""
if [ "$DB_ALREADY_EXISTS" = "true" ]; then
    echo "[Entrypoint] Creating pre-migration backup..."
    BACKUP_PATH=$(drop_privs node -e '
const { backupBeforeMigrate } = require("/app/launcher.js");
const dbFile = process.argv[1];
const backup = backupBeforeMigrate({ dbFile, dataDir: process.argv[3], version: process.argv[2] });
if (!backup) process.exit(1);
process.stdout.write(backup);
' "$TARGET_DB" "$CURRENT_VERSION" "$DB_DIR")
    echo "[Entrypoint] Pre-migration backup saved at: $BACKUP_PATH"
fi

# Run migrations to ensure DB schema is available and up to date.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app
if ! drop_privs $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma; then
    echo "[Entrypoint] Database migration failed; refusing to start." >&2
    if [ -n "$BACKUP_PATH" ]; then
        echo "[Entrypoint] Restore database from pre-migration backup: $BACKUP_PATH" >&2
    fi
    exit 1
fi
echo "[Entrypoint] Migrations completed successfully."

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    if [ "$DB_ALREADY_EXISTS" = "true" ] && [ "${PRESERVE_EXISTING_DATA:-false}" = "true" ]; then
        echo "[Entrypoint] Preserving existing system tags and associations."
    else
        echo "[Entrypoint] Rebuilding system tags to sync with new version..."
        drop_privs node "$REBUILD_TAGS_SCRIPT"
    fi
    # Update version marker
    write_version_file
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"
    
    # 确保证书目录存在
    mkdir -p "$CERT_DIR"
    if [ "$(id -u)" = "0" ]; then
        chown nextjs:nodejs "$CERT_DIR" 2>/dev/null || true
    fi
    
    # 检查证书是否存在
    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."
        
        # 获取证书 CN（优先使用环境变量，否则使用 localhost）
        CERT_CN="${CERT_DOMAIN:-localhost}"
        
        # 生成自签名证书（有效期 10 年）
        if openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chmod 600 "$KEY_FILE"
            if [ "$(id -u)" = "0" ]; then
                chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
            fi
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
        if [ "$(id -u)" = "0" ]; then
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE" 2>/dev/null || true
        fi
        chmod 600 "$KEY_FILE" 2>/dev/null || true
    fi
    
    # 启动 HTTPS 代理
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        HTTPS_LISTEN_PORT="${HTTPS_PORT:-8443}"
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 ${HTTPS_LISTEN_PORT})..."
        drop_privs node /app/https-server.js &
    fi
fi

# Execute the main container command (drop privileges when started as root)
if [ -n "$DROP_PRIVS" ]; then
    exec "$DROP_PRIVS" nextjs:nodejs "$@"
fi
exec "$@"
