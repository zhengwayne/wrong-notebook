// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: 'parent-1', email: 'parent-home@example.com', role: 'user' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/config', () => ({ getAppTimeZone: () => 'Asia/Taipei' }));
vi.mock('@/lib/learning-path/ai', () => ({
    suggestKnowledgeOrder: async (points: Array<{ knowledgePoint: string }>) => ({
        order: points.map((item) => item.knowledgePoint),
        usedAi: false,
    }),
}));

import { GET as GET_HOME } from '@/app/api/parent/home/route';

let directory: string;
let db: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'parent-home-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

beforeEach(async () => {
    await db.learningPath.deleteMany();
    await db.knowledgeMastery.deleteMany();
    await db.practiceRecord.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();

    await db.user.create({
        data: {
            id: 'parent-1',
            email: mocks.session.user.email,
            password: 'test-only',
            personas: '["parent"]',
            activePersona: 'parent',
            personasConfirmedAt: new Date(),
        },
    });
    await db.subject.create({
        data: { id: 'nb-math', name: '数学', stage: 'junior_high', subjectKey: 'math', userId: 'parent-1' },
    });
    await db.knowledgeTag.createMany({ data: [
        { id: 'tag-eq', name: '方程', subject: 'math', isSystem: true, order: 1 },
        { id: 'tag-parent', name: '家长自己的题', subject: 'math', isSystem: true, order: 2 },
        { id: 'tag-sib', name: '几何', subject: 'math', isSystem: true, order: 3 },
    ] });
    await db.learner.createMany({ data: [
        { id: 'child-a', userId: 'parent-1', kind: 'child', name: '小明', order: 0 },
        { id: 'child-b', userId: 'parent-1', kind: 'child', name: '小红', order: 1 },
    ] });
    await db.errorItem.create({
        data: {
            id: 'item-parent', shortId: 'Pa0001', userId: 'parent-1', subjectId: 'nb-math',
            questionText: '家长自己的题', originalImageUrl: '', errorType: '概念',
            knowledgePoints: '["家长自己的题"]',
            tags: { connect: [{ id: 'tag-parent' }] },
        },
    });
    await db.errorItem.create({
        data: {
            id: 'item-a', shortId: 'Ca0001', userId: 'parent-1', subjectId: 'nb-math', learnerId: 'child-a',
            questionText: '小明的方程', originalImageUrl: '', errorType: '计算',
            knowledgePoints: '["方程"]',
            tags: { connect: [{ id: 'tag-eq' }] },
        },
    });
    await db.errorItem.create({
        data: {
            id: 'item-b', shortId: 'Cb0001', userId: 'parent-1', subjectId: 'nb-math', learnerId: 'child-b',
            questionText: '小红的几何', originalImageUrl: '', errorType: '审题',
            knowledgePoints: '["几何"]',
            tags: { connect: [{ id: 'tag-sib' }] },
        },
    });
    const now = new Date();
    await db.practiceRecord.createMany({ data: [
        { id: 'pr-a1', userId: 'parent-1', learnerId: 'child-a', errorItemId: 'item-a', result: 'correct', isCorrect: true, createdAt: now },
        { id: 'pr-a2', userId: 'parent-1', learnerId: 'child-a', errorItemId: 'item-a', result: 'wrong', isCorrect: false, createdAt: now },
        { id: 'pr-b', userId: 'parent-1', learnerId: 'child-b', errorItemId: 'item-b', result: 'correct', isCorrect: true, createdAt: now },
        { id: 'pr-self', userId: 'parent-1', learnerId: null, errorItemId: 'item-parent', result: 'correct', isCorrect: true, createdAt: now },
    ] });
});

afterAll(async () => {
    await db?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('家长首页接口', () => {
    it('shows the selected child only, without parent or sibling data mixed in', async () => {
        const response = await GET_HOME(new Request('http://localhost/api/parent/home?learnerId=child-a&language=zh'));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.children.map((child: { name: string }) => child.name)).toEqual(['小明', '小红']);
        expect(data.selectedLearnerId).toBe('child-a');
        expect(data.child.name).toBe('小明');
        const points = data.child.weakPoints.map((item: { knowledgePoint: string }) => item.knowledgePoint);
        expect(points).toContain('方程');
        expect(points).not.toContain('几何');
        expect(points).not.toContain('家长自己的题');
        expect(data.child.today.length).toBeGreaterThan(0);
        expect(data.child.practiceSummary).toEqual({ attempted: 2, correct: 1 });
        const todayAttempted = data.child.practiceTrend.reduce((sum: number, day: { attempted: number }) => sum + day.attempted, 0);
        expect(todayAttempted).toBe(2);
    });
});
