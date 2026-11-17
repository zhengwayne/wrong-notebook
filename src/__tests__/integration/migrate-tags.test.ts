/**
 * /api/admin/migrate-tags 集成测试：验证单连接事务内透传 tx 创建自定义回退标签不发生死锁
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSqlitePragmas } from '@/lib/prisma';
import { normalizeSqliteUrl } from '@/lib/sqlite-pragmas';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as { user: { id: string; email: string; role: string } } | null,
}));

vi.mock('@/lib/prisma', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/prisma')>();
    return {
        ...actual,
        get prisma() {
            return mocks.prisma;
        },
    };
});
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST } from '@/app/api/admin/migrate-tags/route';

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-tags-'));
const dbFile = path.join(dir, 'test.db');
const baseUrl = `file:${dbFile.split(path.sep).join('/')}`;

execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')], {
    env: { ...process.env, DATABASE_URL: baseUrl },
    cwd: REPO_ROOT,
    stdio: 'pipe',
});

const normalizedUrl = normalizeSqliteUrl(baseUrl)!;
const db = attachSqlitePragmas(
    new PrismaClient({ datasources: { db: { url: normalizedUrl } } }),
    normalizedUrl,
    {} as NodeJS.ProcessEnv,
);
mocks.prisma = db;

afterAll(async () => {
    await db.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/admin/migrate-tags', () => {
    beforeEach(async () => {
        mocks.session = null;
        await db.errorItem.deleteMany();
        await db.knowledgeTag.deleteMany();
        await db.subject.deleteMany();
        await db.user.deleteMany();
    });

    it('未登录或非管理员时拒绝迁移', async () => {
        const unauthRes = await POST();
        expect(unauthRes.status).toBe(401);

        mocks.session = { user: { id: 'u1', email: 'u1@example.com', role: 'user' } };
        const forbidRes = await POST();
        expect(forbidRes.status).toBe(403);
    });

    it('系统标签重建后遇到未命中标签时，在单连接事务内用 tx 挂载年级父节点并创建自定义标签', async () => {
        const admin = await db.user.create({
            data: { id: 'admin-1', email: 'admin@example.com', password: 'hash', role: 'admin', name: 'Admin' },
        });
        const oldSysTag = await db.knowledgeTag.create({
            data: { name: '将被移除的旧系统知识点', subject: 'math', isSystem: true, parentId: null },
        });
        const item = await db.errorItem.create({
            data: {
                userId: admin.id,
                originalImageUrl: '',
                questionText: '测试题目',
                gradeSemester: '七年级上',
                tags: { connect: [{ id: oldSysTag.id }] },
            },
        });

        mocks.session = { user: { id: admin.id, email: admin.email, role: 'admin' } };
        const res = await POST();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.count).toBeGreaterThan(0);
        expect(body.customTagsCreated).toBe(1);
        expect(body.associationsRestored).toBe(1);

        const refreshed = await db.errorItem.findUniqueOrThrow({
            where: { id: item.id },
            include: { tags: { include: { parent: true } } },
        });
        expect(refreshed.tags).toHaveLength(1);
        expect(refreshed.tags[0].isSystem).toBe(false);
        expect(refreshed.tags[0].name).toBe('将被移除的旧系统知识点');
        expect(refreshed.tags[0].parent?.name).toBe('七年级上');
    }, 30000);
});
