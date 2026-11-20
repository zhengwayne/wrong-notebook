/**
 * 数据库每日快照集成测试：验证真实 WAL 库 VACUUM INTO、完整性校验、7 份保留、禁用开关与失败告警接口
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    session: null as { user: { id?: string; email: string; role: string } } | null,
    db: undefined as PrismaClient | undefined,
}));

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/prisma')>();
    return {
        ...actual,
        get prisma() {
            return mocks.db ?? actual.prisma;
        },
    };
});

import { GET, POST } from '@/app/api/system/snapshot-status/route';
import { getDailySnapshotStatus, runDailySnapshot } from '@/lib/daily-snapshot';
import { attachSqlitePragmas } from '@/lib/prisma';
import { normalizeSqliteUrl } from '@/lib/sqlite-pragmas';

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');

function createTempWalDb(dir: string) {
    const dbFile = path.join(dir, 'wrong-notebook.db');
    const baseUrl = `file:${dbFile.split(path.sep).join('/')}`;
    execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: baseUrl },
        cwd: REPO_ROOT,
        stdio: 'pipe',
    });
    const url = normalizeSqliteUrl(baseUrl)!;
    const db = attachSqlitePragmas(new PrismaClient({ datasources: { db: { url } } }), url);
    return { dbFile, baseUrl, db };
}

describe('每日一致性快照 (OPT-22)', () => {
    const originalDbUrl = process.env.DATABASE_URL;
    const originalHome = process.env.WRONG_NOTEBOOK_HOME;
    const originalEnabled = process.env.DAILY_SNAPSHOT_ENABLED;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-snapshot-'));
        mocks.session = null;
        mocks.db = undefined;
    });

    afterEach(() => {
        process.env.DATABASE_URL = originalDbUrl;
        if (originalHome === undefined) delete process.env.WRONG_NOTEBOOK_HOME;
        else process.env.WRONG_NOTEBOOK_HOME = originalHome;
        if (originalEnabled === undefined) delete process.env.DAILY_SNAPSHOT_ENABLED;
        else process.env.DAILY_SNAPSHOT_ENABLED = originalEnabled;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('在 WAL 模式下生成的快照可直接连接查询并通过 PRAGMA integrity_check', async () => {
        const { dbFile, db } = createTempWalDb(tmpDir);
        const env = {
            DATABASE_URL: `file:${dbFile.split(path.sep).join('/')}`,
            WRONG_NOTEBOOK_HOME: tmpDir,
        } as unknown as NodeJS.ProcessEnv;

        try {
            await db.user.create({
                data: {
                    email: 'snap@example.com',
                    password: 'hash',
                    name: '快照测试用户',
                },
            });

            const status = await runDailySnapshot({
                db,
                env,
                now: new Date('2026-11-18T02:00:00Z'),
            });

            expect(status.enabled).toBe(true);
            expect(status.lastError).toBeNull();
            expect(status.snapshotCount).toBe(1);
            expect(status.lastSnapshotName).toBe('daily-snapshot-2026-11-18.db');

            const snapFile = path.join(tmpDir, 'backups', status.lastSnapshotName!);
            expect(fs.existsSync(snapFile)).toBe(true);

            // 直接把快照文件当作完整数据库启动，验证数据与完整性检查均通过
            const snapClient = new PrismaClient({
                datasources: { db: { url: `file:${snapFile.split(path.sep).join('/')}?connection_limit=1` } },
            });
            try {
                const integrity = await snapClient.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check;');
                expect(integrity[0]?.integrity_check).toBe('ok');
                const user = await snapClient.user.findUnique({ where: { email: 'snap@example.com' } });
                expect(user?.name).toBe('快照测试用户');
            } finally {
                await snapClient.$disconnect();
            }
        } finally {
            await db.$disconnect();
        }
    }, 20000);

    it('连续运行 9 天只保留最近 7 份快照', async () => {
        const { dbFile, db } = createTempWalDb(tmpDir);
        const env = {
            DATABASE_URL: `file:${dbFile.split(path.sep).join('/')}`,
            WRONG_NOTEBOOK_HOME: tmpDir,
        } as unknown as NodeJS.ProcessEnv;

        try {
            for (let day = 1; day <= 9; day++) {
                const dateStr = `2026-11-${String(day).padStart(2, '0')}T03:00:00Z`;
                await runDailySnapshot({ db, env, now: new Date(dateStr) });
            }

            const files = fs.readdirSync(path.join(tmpDir, 'backups'))
                .filter((name) => name.startsWith('daily-snapshot-') && name.endsWith('.db'))
                .sort();
            expect(files).toHaveLength(7);
            expect(files[0]).toBe('daily-snapshot-2026-11-03.db');
            expect(files[6]).toBe('daily-snapshot-2026-11-09.db');
        } finally {
            await db.$disconnect();
        }
    }, 30000);

    it('DAILY_SNAPSHOT_ENABLED=false 时跳过创建快照', async () => {
        const { dbFile, db } = createTempWalDb(tmpDir);
        const env = {
            DATABASE_URL: `file:${dbFile.split(path.sep).join('/')}`,
            WRONG_NOTEBOOK_HOME: tmpDir,
            DAILY_SNAPSHOT_ENABLED: 'false',
        } as unknown as NodeJS.ProcessEnv;

        try {
            const status = await runDailySnapshot({ db, env, now: new Date('2026-11-18T02:00:00Z') });
            expect(status.enabled).toBe(false);
            expect(status.snapshotCount).toBe(0);
            expect(fs.existsSync(path.join(tmpDir, 'backups'))).toBe(false);
        } finally {
            await db.$disconnect();
        }
    }, 15000);

    it('快照失败时脱敏记录 lastError，且可通过 GET /api/system/snapshot-status 获取；POST 仅管理员可触发', async () => {
        const dbFile = path.join(tmpDir, 'wrong-notebook.db');
        process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;
        process.env.WRONG_NOTEBOOK_HOME = tmpDir;
        delete process.env.DAILY_SNAPSHOT_ENABLED;

        // 将 backups 位置占用为普通文件，模拟不可写目录失败
        fs.writeFileSync(path.join(tmpDir, 'backups'), 'blocked');
        const fakeDb = {
            $executeRawUnsafe: vi.fn(),
            $queryRawUnsafe: vi.fn(),
            user: {
                findUnique: vi.fn(async () => ({
                    id: 'user-1',
                    email: 'user@example.com',
                    role: 'user',
                    isActive: true,
                    authVersion: 0,
                })),
            },
        };

        const failedStatus = await runDailySnapshot({
            db: fakeDb,
            env: process.env,
            now: new Date('2026-11-18T02:00:00Z'),
        });
        expect(failedStatus.lastError).toBeTruthy();
        expect(failedStatus.lastError).not.toContain(tmpDir);

        expect(getDailySnapshotStatus(process.env).lastError).toBe(failedStatus.lastError);

        // 未登录 GET -> 401
        expect((await GET()).status).toBe(401);

        // 已登录用户 GET -> 200 含 lastError
        mocks.db = fakeDb as unknown as PrismaClient;
        mocks.session = { user: { id: 'user-1', email: 'user@example.com', role: 'user' } };
        const getRes = await GET();
        expect(getRes.status).toBe(200);
        const getData = await getRes.json();
        expect(getData.lastError).toBe(failedStatus.lastError);

        // 普通用户 POST -> 403
        expect((await POST()).status).toBe(403);
    });
});
