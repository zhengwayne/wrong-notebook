// @vitest-environment node
/**
 * 反复错题榜：只统计同一账号、同一学习者的错题与作答记录（Ported from margrop/wrong-notebook 07e4dca9, MIT）
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as { user: { id: string; email: string; name: string; role: string }; expires: string } | null,
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET } from '@/app/api/stats/repeated-mistakes/route';

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb('repeated-mistakes-');
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    await db.practiceRecord.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();
});

function login(user: { id: string; email: string }) {
    mocks.session = { user: { id: user.id, email: user.email, name: user.email, role: 'user' }, expires: '2099-01-01' };
}

async function seedUser(email: string) {
    const user = await db.user.create({ data: { email, password: 'x', name: email } });
    const subject = await db.subject.create({ data: { name: '数学', userId: user.id } });
    const child = await db.learner.create({ data: { userId: user.id, kind: 'child', name: `${email}-孩子` } });
    return { user, subject, child };
}

async function seedItem(userId: string, subjectId: string, learnerId: string | null, questionText: string, wrongTimes: number, correctTimes = 0) {
    const item = await db.errorItem.create({ data: { userId, subjectId, learnerId, originalImageUrl: '', questionText } });
    for (let i = 0; i < wrongTimes; i++) {
        await db.practiceRecord.create({ data: { userId, learnerId, errorItemId: item.id, result: 'wrong', isCorrect: false, createdAt: new Date(Date.UTC(2026, 10, 1 + i)) } });
    }
    for (let i = 0; i < correctTimes; i++) {
        await db.practiceRecord.create({ data: { userId, learnerId, errorItemId: item.id, result: 'correct', isCorrect: true } });
    }
    return item;
}

async function fetchItems(query = '') {
    const res = await GET(new Request(`http://localhost/api/stats/repeated-mistakes${query}`));
    expect(res.status).toBe(200);
    return (await res.json()).items as Array<{ id: string; wrongCount: number; preview: string | null; lastWrongAt: string | null; masteryStatus: string }>;
}

describe('GET /api/stats/repeated-mistakes', () => {
    it('未登录返回 401', async () => {
        mocks.session = null;
        const res = await GET(new Request('http://localhost/api/stats/repeated-mistakes'));
        expect(res.status).toBe(401);
    });

    it('只列出做错 2 次及以上的题目，按出错次数降序', async () => {
        const alice = await seedUser('alice@example.com');
        const three = await seedItem(alice.user.id, alice.subject.id, null, '**三次错** $x+1=2$', 3, 1);
        const two = await seedItem(alice.user.id, alice.subject.id, null, '两次错', 2);
        await seedItem(alice.user.id, alice.subject.id, null, '只错一次', 1);
        login(alice.user);

        const items = await fetchItems();
        expect(items.map((item) => item.id)).toEqual([three.id, two.id]);
        expect(items[0]).toMatchObject({ wrongCount: 3, preview: '三次错 x+1=2', masteryStatus: 'reviewing' });
        expect(items[0].lastWrongAt).toMatch(/^2026-11-0\d$/);
    });

    it('本人与孩子分开统计，别的账号的数据和学习者都不可见', async () => {
        const alice = await seedUser('alice@example.com');
        const bob = await seedUser('bob@example.com');
        const selfItem = await seedItem(alice.user.id, alice.subject.id, null, '本人', 2);
        const childItem = await seedItem(alice.user.id, alice.subject.id, alice.child.id, '孩子', 4);
        await seedItem(bob.user.id, bob.subject.id, null, 'Bob 本人', 5);
        await seedItem(bob.user.id, bob.subject.id, bob.child.id, 'Bob 孩子', 5);
        login(alice.user);

        expect((await fetchItems()).map((item) => item.id)).toEqual([selfItem.id]);
        expect((await fetchItems(`?learnerId=${alice.child.id}`)).map((item) => item.id)).toEqual([childItem.id]);

        // 不能借用别人孩子的 learnerId
        const res = await GET(new Request(`http://localhost/api/stats/repeated-mistakes?learnerId=${bob.child.id}`));
        expect(res.status).toBe(404);
    });

    it('作答记录与题目的学习者不一致时不计入', async () => {
        const alice = await seedUser('alice@example.com');
        const childItem = await db.errorItem.create({ data: { userId: alice.user.id, subjectId: alice.subject.id, learnerId: alice.child.id, originalImageUrl: '', questionText: '孩子的题' } });
        // 历史脏数据：本人作用域的作答记录挂在孩子的题目上
        for (let i = 0; i < 3; i++) {
            await db.practiceRecord.create({ data: { userId: alice.user.id, learnerId: null, errorItemId: childItem.id, result: 'wrong' } });
        }
        login(alice.user);
        expect(await fetchItems()).toEqual([]);
    });

    it('最多返回 10 道题', async () => {
        const alice = await seedUser('alice@example.com');
        for (let i = 0; i < 12; i++) await seedItem(alice.user.id, alice.subject.id, null, `题 ${i}`, 2);
        login(alice.user);
        expect(await fetchItems()).toHaveLength(10);
    });

    it('支持教师按 classId 统计全班，并计入 not_attempted 与历史 result=null/isCorrect=false 记录', async () => {
        const teacher = await seedUser('teacher@example.com');
        const other = await seedUser('other@example.com');
        const cls = await db.gradingClass.create({ data: { userId: teacher.user.id, name: '三班' } });
        const otherCls = await db.gradingClass.create({ data: { userId: other.user.id, name: '外班' } });
        const stu = await db.gradingStudent.create({ data: { classId: cls.id, name: '小红' } });
        const stuLearner = await db.learner.create({ data: { userId: teacher.user.id, kind: 'student', name: '小红', gradingStudentId: stu.id } });

        await seedItem(teacher.user.id, teacher.subject.id, null, '教师自己的题', 3);
        const stuItem = await db.errorItem.create({
            data: { userId: teacher.user.id, subjectId: teacher.subject.id, learnerId: stuLearner.id, originalImageUrl: '', questionText: '学生不会与旧错题' },
        });
        await db.practiceRecord.create({ data: { userId: teacher.user.id, learnerId: stuLearner.id, errorItemId: stuItem.id, result: 'not_attempted', isCorrect: false } });
        await db.practiceRecord.create({ data: { userId: teacher.user.id, learnerId: stuLearner.id, errorItemId: stuItem.id, result: null, isCorrect: false } });
        await db.practiceRecord.create({ data: { userId: teacher.user.id, learnerId: stuLearner.id, errorItemId: stuItem.id, result: 'correct', isCorrect: true } });
        login(teacher.user);

        const classItems = await fetchItems(`?classId=${cls.id}`);
        expect(classItems).toHaveLength(1);
        expect(classItems[0]).toMatchObject({ id: stuItem.id, wrongCount: 2 });

        const forbiddenRes = await GET(new Request(`http://localhost/api/stats/repeated-mistakes?classId=${otherCls.id}`));
        expect(forbiddenRes.status).toBe(404);
    });
});
