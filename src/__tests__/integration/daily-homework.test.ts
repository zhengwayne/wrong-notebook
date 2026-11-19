// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: {
        user: { id: 'parent-hw', email: 'hw@example.com', role: 'user', authVersion: 0 },
        expires: '2099-01-01',
    },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET as LIST_HW, POST as CREATE_HW } from '@/app/api/parent/homeworks/route';
import { PATCH as UPDATE_HW, DELETE as DELETE_HW } from '@/app/api/parent/homeworks/[id]/route';
import { GET as EXPORT_ZIP } from '@/app/api/export/route';
import { POST as IMPORT_ZIP } from '@/app/api/import/route';
import { shiftDateKey } from '@/lib/daily-homework';

let database: PrismaClient;
let directory: string;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-daily-hw-'));
    process.env.CONFIG_DIR = join(directory, 'config');
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    await database.dailyHomeworkItem.deleteMany();
    await database.practiceRecord.deleteMany();
    await database.learner.deleteMany();
    await database.user.deleteMany();

    await database.user.create({
        data: { id: 'parent-hw', email: 'hw@example.com', password: 'test' },
    });
    await database.user.create({
        data: { id: 'stranger', email: 'stranger@example.com', password: 'test' },
    });
    await database.learner.create({
        data: { id: 'kid-1', userId: 'parent-hw', kind: 'child', name: '朵朵' },
    });
    await database.learner.create({
        data: { id: 'kid-stranger', userId: 'stranger', kind: 'child', name: '外人' },
    });
});

afterAll(async () => {
    delete process.env.CONFIG_DIR;
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('家长每日全科作业清单与备份往返集成测试', () => {
    it('历史日期和跨查询批次的连续打卡计入练习及作业', async () => {
        const first = '2020-01-01';
        await database.dailyHomeworkItem.createMany({ data: Array.from({ length: 75 }, (_, i) => ({
            userId: 'parent-hw', learnerId: 'kid-1', dateKey: shiftDateKey(first, i), completed: true, title: '复习',
        })) });
        const last = shiftDateKey(first, 75);
        await database.practiceRecord.create({ data: {
            userId: 'parent-hw', learnerId: 'kid-1', result: 'correct', isCorrect: true,
            createdAt: new Date(`${last}T01:00:00Z`),
        } });
        for (const day of [last, shiftDateKey(last, 1)]) {
            const response = await LIST_HW(new Request(`http://localhost/api/parent/homeworks?learnerId=kid-1&dateKey=${day}`));
            expect((await response.json()).summary.streakDays).toBe(76);
        }
    });
    it('支持增删改查、防跨户 IDOR、联动练习记录计算连续打卡并支持 v3 备份恢复', async () => {
        // 越权读取别人家孩子的作业返回 404
        const idorRes = await LIST_HW(new Request('http://127.0.0.1/api/parent/homeworks?learnerId=kid-stranger&dateKey=2026-11-19'));
        expect(idorRes.status).toBe(404);

        // 昨天有一条练习记录，前天有一条已完成的作业
        await database.dailyHomeworkItem.create({
            data: {
                userId: 'parent-hw',
                learnerId: 'kid-1',
                dateKey: '2026-11-17',
                subjectKey: 'chinese',
                category: 'recitation',
                title: '背诵古诗《山居秋暝》',
                completed: true,
                completedAt: new Date('2026-11-17T12:00:00Z'),
            },
        });
        await database.practiceRecord.create({
            data: {
                userId: 'parent-hw',
                learnerId: 'kid-1',
                subject: 'math',
                result: 'correct',
                isCorrect: true,
                createdAt: new Date('2026-11-18T12:00:00Z'),
            },
        });

        // 创建今天的英语听写与数学书面作业
        const createRes = await CREATE_HW(new Request('http://127.0.0.1/api/parent/homeworks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                learnerId: 'kid-1',
                dateKey: '2026-11-19',
                subjectKey: 'english',
                category: 'dictation',
                title: 'Unit 4 单词听写 15 个',
                estimatedMinutes: 20,
            }),
        }));
        expect(createRes.status).toBe(201);
        const created = await createRes.json();
        expect(created.title).toBe('Unit 4 单词听写 15 个');

        // 勾选完成今天这项作业 -> 2026-11-17(作业) + 2026-11-18(练习) + 2026-11-19(作业) = 连续 3 天！
        const patchRes = await UPDATE_HW(
            new Request(`http://127.0.0.1/api/parent/homeworks/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ completed: true, actualMinutes: 15 }),
            }),
            { params: Promise.resolve({ id: created.id }) },
        );
        expect(patchRes.status).toBe(200);

        const listRes = await LIST_HW(
            new Request('http://127.0.0.1/api/parent/homeworks?learnerId=kid-1&dateKey=2026-11-19'),
        );
        expect(listRes.status).toBe(200);
        const listed = await listRes.json();
        expect(listed.summary).toMatchObject({
            total: 1,
            completed: 1,
            estimatedMinutes: 20,
            streakDays: 3,
        });

        // 验证 v3 ZIP 备份导出再清空恢复后完整保留 DailyHomeworkItem
        const exportRes = await EXPORT_ZIP(new Request('http://127.0.0.1/api/export'));
        expect(exportRes.status).toBe(200);
        const zipBytes = new Uint8Array(await exportRes.arrayBuffer());

        await database.dailyHomeworkItem.deleteMany();
        await database.practiceRecord.deleteMany();
        await database.learner.deleteMany();

        const form = new FormData();
        form.append('file', new Blob([Buffer.from(zipBytes)], { type: 'application/zip' }), 'backup.zip');
        const importRes = await IMPORT_ZIP(new Request('http://127.0.0.1/api/import', {
            method: 'POST',
            body: form,
        }));
        expect(importRes.status).toBe(200);
        const restoredItems = await database.dailyHomeworkItem.findMany({ where: { userId: 'parent-hw' } });
        expect(restoredItems).toHaveLength(2);
        expect(restoredItems.map((r) => r.title).sort()).toEqual([
            'Unit 4 单词听写 15 个',
            '背诵古诗《山居秋暝》',
        ]);

        // 删除测试
        const itemToDelete = restoredItems[0];
        const delRes = await DELETE_HW(
            new Request(`http://127.0.0.1/api/parent/homeworks/${itemToDelete.id}`, { method: 'DELETE' }),
            { params: Promise.resolve({ id: itemToDelete.id }) },
        );
        expect(delRes.status).toBe(200);
        expect(await database.dailyHomeworkItem.count({ where: { userId: 'parent-hw' } })).toBe(1);
    });
});
