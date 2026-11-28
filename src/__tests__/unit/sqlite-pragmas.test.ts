/**
 * SQLite URL 规范化、PRAGMA 初始化、并发读写与 ESLint 事务规则单元测试
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { noPrismaInTransactionRule } from '../../../eslint.config.mjs';
import { attachSqlitePragmas } from '@/lib/prisma';
import { normalizeSqliteUrl, resolveSqlitePragmas } from '@/lib/sqlite-pragmas';

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');

function deployTestDb(dbFile: string): string {
    const url = `file:${dbFile.split(path.sep).join('/')}`;
    execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: url },
        cwd: REPO_ROOT,
        stdio: 'pipe',
    });
    return url;
}

describe('normalizeSqliteUrl', () => {
    it('为无参数的 file: URL 自动补充 connection_limit=1', () => {
        expect(normalizeSqliteUrl('file:./dev.db')).toBe('file:./dev.db?connection_limit=1');
    });

    it('已有其他查询参数时追加 &connection_limit=1', () => {
        expect(normalizeSqliteUrl('file:/data/app.db?mode=rwc')).toBe('file:/data/app.db?mode=rwc&connection_limit=1');
    });

    it('已显式声明 connection_limit 时保持原样', () => {
        expect(normalizeSqliteUrl('file:./dev.db?connection_limit=3')).toBe('file:./dev.db?connection_limit=3');
    });

    it('非 file: URL 或空值原样返回', () => {
        expect(normalizeSqliteUrl(undefined)).toBeUndefined();
        expect(normalizeSqliteUrl('postgresql://localhost/db')).toBe('postgresql://localhost/db');
    });
});

describe('resolveSqlitePragmas', () => {
    it('默认返回 WAL + NORMAL + 5000ms + foreign_keys=ON', () => {
        expect(resolveSqlitePragmas({} as NodeJS.ProcessEnv)).toEqual({
            journalMode: 'WAL',
            synchronous: 'NORMAL',
            busyTimeoutMs: 5000,
            foreignKeys: 'ON',
        });
    });

    it.each(['DELETE', 'delete', 'TRUNCATE', 'PERSIST'])('%s 模式自动切换 synchronous=FULL', (mode) => {
        const resolved = resolveSqlitePragmas({ SQLITE_JOURNAL_MODE: mode } as unknown as NodeJS.ProcessEnv);
        expect(resolved.journalMode).toBe(mode.toUpperCase());
        expect(resolved.synchronous).toBe('FULL');
    });

    it('非法日志模式回退为 WAL', () => {
        const resolved = resolveSqlitePragmas({ SQLITE_JOURNAL_MODE: 'INVALID_MODE' } as unknown as NodeJS.ProcessEnv);
        expect(resolved.journalMode).toBe('WAL');
        expect(resolved.synchronous).toBe('NORMAL');
    });
});

describe('ESLint 规则 local/no-prisma-in-transaction', () => {
    const linter = new Linter({ configType: 'flat' });
    const config = [
        {
            plugins: {
                local: {
                    rules: {
                        'no-prisma-in-transaction': noPrismaInTransactionRule as never,
                    },
                },
            },
            rules: {
                'local/no-prisma-in-transaction': 'error' as const,
            },
        },
    ];

    it('拦截 $transaction 回调内直接引用全局 prisma', () => {
        const messages = linter.verify(
            'await prisma.$transaction(async (tx) => { await prisma.user.findMany(); });',
            config,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0].ruleId).toBe('local/no-prisma-in-transaction');
    });

    it('放行事务句柄 tx、数组式事务、成员名与局部遮蔽变量', () => {
        const safeCode = [
            'await prisma.$transaction(async (tx) => { await tx.user.findMany(); const x = { prisma: tx }; return obj.prisma; });',
            'await prisma.$transaction([prisma.user.deleteMany()]);',
            'await prisma.$transaction(async (prisma) => { await prisma.user.findMany(); });',
        ].join('\n');
        const messages = linter.verify(safeCode, config);
        expect(messages).toEqual([]);
    });
});

describe('真实 SQLite 连接参数与并发读写压测', () => {
    it('默认初始化 WAL/NORMAL/busy_timeout=5000/foreign_keys=1 且 10 读 + 3 写并发零冲突', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-pragma-wal-'));
        const baseUrl = deployTestDb(path.join(dir, 'test.db'));
        const normalized = normalizeSqliteUrl(baseUrl)!;
        const client = attachSqlitePragmas(
            new PrismaClient({ datasources: { db: { url: normalized } } }),
            normalized,
            {} as NodeJS.ProcessEnv,
        );

        try {
            // 首次业务查询触发幂等 PRAGMA 初始化
            expect(await client.user.count()).toBe(0);

            const [journalRows, timeoutRows, fkRows, syncRows] = await Promise.all([
                client.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode;'),
                client.$queryRawUnsafe<Array<{ timeout: number | bigint }>>('PRAGMA busy_timeout;'),
                client.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>('PRAGMA foreign_keys;'),
                client.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>('PRAGMA synchronous;'),
            ]);

            expect(journalRows[0]?.journal_mode.toLowerCase()).toBe('wal');
            expect(Number(timeoutRows[0]?.timeout)).toBe(5000);
            expect(Number(fkRows[0]?.foreign_keys)).toBe(1);
            expect(Number(syncRows[0]?.synchronous)).toBe(1); // NORMAL

            const writes = Array.from({ length: 3 }, (_, idx) =>
                client.$transaction(async (tx) => {
                    return tx.user.create({
                        data: {
                            email: `concurrent-${idx}@example.com`,
                            password: 'hash',
                            name: `User ${idx}`,
                        },
                    });
                }),
            );
            const reads = Array.from({ length: 10 }, () => client.user.findMany({ select: { id: true } }));

            await expect(Promise.all([...reads, ...writes])).resolves.toHaveLength(13);
            expect(await client.user.count()).toBe(3);
        } finally {
            await client.$disconnect();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 15000);

    it('SQLITE_JOURNAL_MODE=DELETE 时切换为 delete + synchronous=2 (FULL)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-pragma-del-'));
        const baseUrl = deployTestDb(path.join(dir, 'test.db'));
        const normalized = normalizeSqliteUrl(baseUrl)!;
        const client = attachSqlitePragmas(
            new PrismaClient({ datasources: { db: { url: normalized } } }),
            normalized,
            { SQLITE_JOURNAL_MODE: 'DELETE' } as unknown as NodeJS.ProcessEnv,
        );

        try {
            expect(await client.user.count()).toBe(0);
            const journalRows = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode;');
            const syncRows = await client.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>('PRAGMA synchronous;');
            expect(journalRows[0]?.journal_mode.toLowerCase()).toBe('delete');
            expect(Number(syncRows[0]?.synchronous)).toBe(2); // FULL
        } finally {
            await client.$disconnect();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 15000);
});
