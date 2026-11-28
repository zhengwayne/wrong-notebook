import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient } from '@prisma/client';
import { applySqlitePragmas, normalizeSqliteUrl } from './sqlite-pragmas';

const pragmaBypassStorage = new AsyncLocalStorage<boolean>();

/**
 * 为 PrismaClient 挂上幂等且防重入的 SQLite PRAGMA 初始化钩子：
 * 首次非重入查询到达时才初始化连接参数，避免模块导入期即触发真实数据库 I/O。
 */
export function attachSqlitePragmas(
    client: PrismaClient,
    rawUrl: string | undefined = process.env.DATABASE_URL,
    env: NodeJS.ProcessEnv = process.env,
): PrismaClient {
    if (!rawUrl?.startsWith('file:') || typeof client.$use !== 'function') {
        return client;
    }

    let pragmaReady = false;
    let pragmaPromise: Promise<void> | null = null;

    client.$use(async (params, next) => {
        if (pragmaReady || pragmaBypassStorage.getStore()) {
            return next(params);
        }
        if (!pragmaPromise) {
            pragmaPromise = pragmaBypassStorage
                .run(true, () => applySqlitePragmas(client, env))
                .then(() => {
                    pragmaReady = true;
                })
                .catch((error) => {
                    pragmaPromise = null;
                    throw error;
                });
        }
        await pragmaPromise;
        return next(params);
    });

    return client;
}

function createPrismaClient(): PrismaClient {
    const normalizedUrl = normalizeSqliteUrl(process.env.DATABASE_URL);
    const client = new PrismaClient({
        ...(normalizedUrl ? { datasources: { db: { url: normalizedUrl } } } : {}),
        log: process.env.DEBUG_DB === 'true'
            ? ['query', 'error', 'warn']
            : (process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']),
    });
    return attachSqlitePragmas(client, normalizedUrl);
}

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
