// @vitest-environment node
/**
 * 批量移动错题到其他错题本：只能移动自己的（及所选学习者的）错题，目标错题本必须属于自己。
 * Ported from margrop/wrong-notebook 1c3f25cf, 52b9891d (MIT)（按本项目的学习者作用域重写）.
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as { user: { id: string; email: string; name: string; role: string }; expires: string } | null,
    kidLearnerId: undefined as string | undefined,
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/server/request-context', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/server/request-context')>()),
    getKidModeLearnerId: () => mocks.kidLearnerId,
}));

import { POST } from '@/app/api/error-items/batch-move/route';

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb('batch-move-');
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    mocks.kidLearnerId = undefined;
    await db.practiceRecord.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();
});

async function seedUser(email: string) {
    const user = await db.user.create({ data: { email, password: 'x', name: email } });
    const math = await db.subject.create({ data: { name: '数学', userId: user.id } });
    const review = await db.subject.create({ data: { name: '数学复习', userId: user.id } });
    const child = await db.learner.create({ data: { userId: user.id, kind: 'child', name: `${email}-孩子` } });
    const item = (learnerId: string | null, text: string) => db.errorItem.create({ data: { userId: user.id, subjectId: math.id, learnerId, originalImageUrl: '', questionText: text } });
    return { user, math, review, child, item };
}

function login(user: { id: string; email: string }) {
    mocks.session = { user: { id: user.id, email: user.email, name: user.email, role: 'user' }, expires: '2099-01-01' };
}

function move(body: unknown) {
    return POST(new Request('http://localhost/api/error-items/batch-move', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
}

describe('POST /api/error-items/batch-move', () => {
    it('未登录返回 401', async () => {
        mocks.session = null;
        expect((await move({ ids: ['x'], subjectId: 'y' })).status).toBe(401);
    });

    it('把自己的错题移到自己的另一个错题本，作答记录保留', async () => {
        const alice = await seedUser('alice@example.com');
        const a = await alice.item(null, 'A');
        const b = await alice.item(alice.child.id, 'B');
        await db.practiceRecord.create({ data: { userId: alice.user.id, errorItemId: a.id, result: 'wrong' } });
        login(alice.user);

        const res = await move({ ids: [a.id, b.id, a.id], subjectId: alice.review.id });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ moved: 2, skipped: 0 });
        const items = await db.errorItem.findMany({ where: { id: { in: [a.id, b.id] } }, select: { subjectId: true } });
        expect(items.every((item) => item.subjectId === alice.review.id)).toBe(true);
        expect(await db.practiceRecord.count({ where: { errorItemId: a.id } })).toBe(1);
    });

    it('别人的错题不会被移动，计入 skipped', async () => {
        const alice = await seedUser('alice@example.com');
        const bob = await seedUser('bob@example.com');
        const mine = await alice.item(null, 'mine');
        const theirs = await bob.item(null, 'theirs');
        login(alice.user);

        const res = await move({ ids: [mine.id, theirs.id], subjectId: alice.review.id });
        expect(await res.json()).toEqual({ moved: 1, skipped: 1 });
        expect((await db.errorItem.findUnique({ where: { id: theirs.id } }))?.subjectId).toBe(bob.math.id);
    });

    it('不能移动到别人的错题本', async () => {
        const alice = await seedUser('alice@example.com');
        const bob = await seedUser('bob@example.com');
        const mine = await alice.item(null, 'mine');
        login(alice.user);

        const res = await move({ ids: [mine.id], subjectId: bob.review.id });
        expect(res.status).toBe(403);
        expect((await db.errorItem.findUnique({ where: { id: mine.id } }))?.subjectId).toBe(alice.math.id);
    });

    it('指定学习者时只移动该学习者的错题；别人的学习者返回 404', async () => {
        const alice = await seedUser('alice@example.com');
        const bob = await seedUser('bob@example.com');
        const self = await alice.item(null, 'self');
        const child = await alice.item(alice.child.id, 'child');
        login(alice.user);

        const res = await move({ ids: [self.id, child.id], subjectId: alice.review.id, learnerId: alice.child.id });
        expect(await res.json()).toEqual({ moved: 1, skipped: 1 });
        expect((await db.errorItem.findUnique({ where: { id: self.id } }))?.subjectId).toBe(alice.math.id);
        expect((await db.errorItem.findUnique({ where: { id: child.id } }))?.subjectId).toBe(alice.review.id);

        expect((await move({ ids: [self.id], subjectId: alice.review.id, learnerId: bob.child.id })).status).toBe(404);
    });

    it('专注做题（儿童）模式下禁止', async () => {
        const alice = await seedUser('alice@example.com');
        const child = await alice.item(alice.child.id, 'child');
        login(alice.user);
        mocks.kidLearnerId = alice.child.id;

        const res = await move({ ids: [child.id], subjectId: alice.review.id });
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('KID_MODE_RESTRICTED');
        expect((await db.errorItem.findUnique({ where: { id: child.id } }))?.subjectId).toBe(alice.math.id);
    });

    it('参数校验：空列表、超过 100 道、缺少目标错题本', async () => {
        const alice = await seedUser('alice@example.com');
        login(alice.user);
        expect((await move({ ids: [], subjectId: alice.review.id })).status).toBe(400);
        expect((await move({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`), subjectId: alice.review.id })).status).toBe(400);
        expect((await move({ ids: ['x'] })).status).toBe(400);
    });
});
