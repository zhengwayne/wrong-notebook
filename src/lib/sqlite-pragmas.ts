import type { PrismaClient } from '@prisma/client';
import { createLogger } from './logger';

const logger = createLogger('sqlite-pragmas');

export const ALLOWED_JOURNAL_MODES = ['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF'] as const;
export type SqliteJournalMode = (typeof ALLOWED_JOURNAL_MODES)[number];
export type SqliteSynchronousMode = 'NORMAL' | 'FULL';

export interface SqlitePragmaConfig {
    journalMode: SqliteJournalMode;
    synchronous: SqliteSynchronousMode;
    busyTimeoutMs: number;
    foreignKeys: 'ON';
}

const FULL_SYNC_MODES = new Set<SqliteJournalMode>(['DELETE', 'TRUNCATE', 'PERSIST']);

/**
 * 为 SQLite file: 连接串追加 connection_limit=1，保证 Prisma 使用单连接池，减少并发写锁争用。
 */
export function normalizeSqliteUrl(rawUrl: string | undefined): string | undefined {
    if (!rawUrl || !rawUrl.startsWith('file:')) {
        return rawUrl;
    }
    const queryIndex = rawUrl.indexOf('?');
    if (queryIndex === -1) {
        return `${rawUrl}?connection_limit=1`;
    }
    const query = rawUrl.slice(queryIndex + 1);
    const hasLimit = query.split('&').some((pair) => pair.split('=')[0] === 'connection_limit');
    if (hasLimit) {
        return rawUrl;
    }
    return query.length > 0 ? `${rawUrl}&connection_limit=1` : `${rawUrl}connection_limit=1`;
}

/**
 * 解析 SQLITE_JOURNAL_MODE 白名单并匹配对应的 synchronous 等级：
 * WAL/MEMORY/OFF 使用 NORMAL，DELETE/TRUNCATE/PERSIST（适合 NAS/NFS/CIFS 网络卷）使用 FULL。
 */
export function resolveSqlitePragmas(env: NodeJS.ProcessEnv = process.env): SqlitePragmaConfig {
    const rawMode = env.SQLITE_JOURNAL_MODE?.trim().toUpperCase();
    let journalMode: SqliteJournalMode = 'WAL';
    if (rawMode) {
        if ((ALLOWED_JOURNAL_MODES as readonly string[]).includes(rawMode)) {
            journalMode = rawMode as SqliteJournalMode;
        } else {
            logger.warn({ mode: rawMode }, 'Invalid SQLITE_JOURNAL_MODE; falling back to WAL');
        }
    }
    const synchronous: SqliteSynchronousMode = FULL_SYNC_MODES.has(journalMode) ? 'FULL' : 'NORMAL';
    return {
        journalMode,
        synchronous,
        busyTimeoutMs: 5000,
        foreignKeys: 'ON',
    };
}

/**
 * 在连接上执行 SQLite PRAGMA 初始化。
 * Prisma SQLite 下 PRAGMA 会返回结果集，必须使用 $queryRawUnsafe。
 */
export async function applySqlitePragmas(
    client: Pick<PrismaClient, '$queryRawUnsafe'>,
    env: NodeJS.ProcessEnv = process.env,
): Promise<SqlitePragmaConfig> {
    const cfg = resolveSqlitePragmas(env);
    await client.$queryRawUnsafe(`PRAGMA busy_timeout = ${cfg.busyTimeoutMs};`);
    await client.$queryRawUnsafe(`PRAGMA journal_mode = ${cfg.journalMode};`);
    await client.$queryRawUnsafe(`PRAGMA synchronous = ${cfg.synchronous};`);
    await client.$queryRawUnsafe(`PRAGMA foreign_keys = ${cfg.foreignKeys};`);
    return cfg;
}
