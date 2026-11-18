# 生产镜像默认使用 Debian/glibc。CentOS 7 (kernel 3.10) + overlay2 上，
# Alpine/musl 的 Prisma query engine 写 SQLite 会报 SQLITE_IOERR_WRITE (778)。
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base

# 可选：构建时传入 Debian 镜像站主机名（如 mirrors.aliyun.com），以及 npm 登记处。
ARG APT_MIRROR=
ARG NPM_CONFIG_REGISTRY=

# Install dependencies only when needed
FROM base AS deps
# FROM 之后需要重新声明，才能在本阶段使用全局 ARG
ARG APT_MIRROR=
ARG NPM_CONFIG_REGISTRY=
# 测试与构建需要的系统包放在复制源码之前，源码变化时不必重新下载
RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
        if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
            sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
        fi; \
        if [ -f /etc/apt/sources.list ]; then \
            sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
        fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 openssl bash ca-certificates; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json ./
# 未传入 NPM_CONFIG_REGISTRY 时走默认源，避免把空 registry 传给 npm
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then npm ci --registry="$NPM_CONFIG_REGISTRY"; else npm ci; fi

# CI uses the same Node version and native dependencies as production builds.
FROM deps AS ci
WORKDIR /app
# QEMU 模拟构建其他架构时测试会慢数倍，可调大单个测试和钩子的超时（毫秒）
ARG TEST_TIMEOUT_MS=5000
# 在内存紧张的构建机上可传 SKIP_TESTS=1，跳过镜像内全量测试
ARG SKIP_TESTS=0
COPY . .
RUN npx prisma generate \
    && if [ "$SKIP_TESTS" != "1" ]; then npm test -- --testTimeout="${TEST_TIMEOUT_MS}" --hookTimeout="${TEST_TIMEOUT_MS}"; fi \
    && sh -n docker-entrypoint.sh \
    && bash -n scripts/ci.sh scripts/build-image.sh

# Rebuild the source code only after the checks pass.
FROM ci AS builder

# Generate Prisma Client and Seed Database
# We temporarily set DATABASE_URL to a local file for the build process to generate the file
ENV DATABASE_URL="file:/app/prisma/dev.db"

# Pre-compile runtime scripts FIRST (needed for tag seeding)
RUN npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

# Initialize database: generate client, run migrations, seed system tags (no admin; created via the one-time setup link)
RUN npx prisma generate \
    && npx prisma migrate deploy \
    && npx prisma db seed \
    && node ./dist-scripts/scripts/rebuild-system-tags.js

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ARG APP_REVISION=unknown
ENV APP_REVISION=${APP_REVISION}
# 由 Git 标签得出的版本号，留空时运行时回退到 package.json 的版本
ARG APP_VERSION=
ENV APP_VERSION=${APP_VERSION}
# Existing installations keep their accounts and tag IDs during deployment.
ENV PRESERVE_EXISTING_DATA=true
LABEL org.opencontainers.image.source="https://github.com/margrop/wrong-notebook" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

# gosu：在 Debian 上把权限降到 nextjs；openssl 供可选的内置 HTTPS 使用
ARG APT_MIRROR=
RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
        if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
            sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
        fi; \
        if [ -f /etc/apt/sources.list ]; then \
            sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
        fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends gosu openssl ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 1001 nodejs; \
    useradd --system --uid 1001 --gid nodejs --no-create-home nextjs

# Copy Prisma CLI and engine files from builder
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# sharp 带平台原生二进制，并被标为 serverExternalPackages。
# Debian/glibc 构建会装上 @img/sharp-linux-x64；这里再显式复制，避免动态 import 漏掉平台包。
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img

# Copy Prisma schema and migrations for runtime usage if needed (e.g. for migrations)
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Copy config directory for runtime
COPY --from=builder --chown=nextjs:nodejs /app/config ./config

# Copy pre-compiled runtime scripts
COPY --from=builder --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/seed-admin.js ./dist-scripts/scripts/seed-admin.js

# SQLite 与上传文件的持久化目录（运行时由卷挂到 /app/data）
RUN mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

# Copy entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
# --chmod 需要 BuildKit；经典构建器用这一步设置可执行位
RUN chmod 755 /app/docker-entrypoint.sh

COPY --chown=nextjs:nodejs https-server.js ./

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

ENV PORT=3000
# set hostname to localhost
ENV HOSTNAME="0.0.0.0"

# Environment variables
# Point to the persistent data location
ENV DATABASE_URL="file:/app/data/dev.db"
ENV AUTH_TRUST_HOST=true

# Use entrypoint script to handle DB initialization
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
