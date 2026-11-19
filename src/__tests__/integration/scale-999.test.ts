// @vitest-environment node
/**
 * 错题规模回归测试：错题超过 SQLite 单条查询的参数上限（999）时，复习、列表、打印视图与统计接口仍应正常返回。
 * 嵌套关系里的否定过滤（如 result: { not: null }）会让 Prisma 无法按父级 id 拆分子查询，父级结果一多就报
 * 「Query parameter limit exceeded」。本项目还按学习者（本人/孩子）分作用域，两种作用域都要覆盖。
 *
 * Ported from margrop/wrong-notebook 10894f9a, 4c81322c (MIT)（规模回归测试思路，按本项目接口与作用域重写）.
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: 'scale-user', email: 'scale@example.com', name: 'scale', role: 'user' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET as ANALYTICS } from '@/app/api/analytics/route';
import { GET as LIST_ERROR_ITEMS } from '@/app/api/error-items/list/route';
import { GET as REVIEW_DUE } from '@/app/api/review/due/route';
import { GET as PRACTICE_STATS } from '@/app/api/stats/practice/route';
import { GET as REPEATED_MISTAKES } from '@/app/api/stats/repeated-mistakes/route';
import { GET as TAG_STATS } from '@/app/api/tags/stats/route';
import { GET as WEAKNESS } from '@/app/api/variants/weakness/route';

/** 必须超过 SQLite 的 999 参数上限才能复现 */
const ITEM_COUNT = 1200;
const CHILD_ITEM_COUNT = 1050;
const DAY = 24 * 60 * 60 * 1000;

let testDb: IsolatedTestDb;
let db: PrismaClient;
let childId: string;

async function seedItems(prefix: string, count: number, learnerId: string | null) {
    const now = Date.now();
    const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
    for (let start = 0; start < ids.length; start += 400) {
        const slice = ids.slice(start, start + 400);
        await db.errorItem.createMany({
            data: slice.map((id) => ({ id, userId: 'scale-user', learnerId, subjectId: 'math', originalImageUrl: '', questionText: `题目 ${id}`, createdAt: new Date(now - 5 * DAY) })),
        });
        await db.practiceRecord.createMany({
            data: slice.flatMap((id, index) => {
                const base = { userId: 'scale-user', learnerId, errorItemId: id, result: 'wrong', isCorrect: false, subject: '数学', source: 'practice' };
                // 前 20 道题做错两次，进入反复错题榜
                return index < 20 && start === 0
                    ? [{ ...base, createdAt: new Date(now - 3 * DAY) }, { ...base, createdAt: new Date(now - 2 * DAY) }]
                    : [{ ...base, createdAt: new Date(now - 3 * DAY) }];
            }),
        });
    }
    return ids;
}

beforeAll(async () => {
    testDb = createIsolatedTestDb('scale-999-');
    db = testDb.db;
    mocks.prisma = db;

    await db.user.create({ data: { id: 'scale-user', email: 'scale@example.com', password: 'test-only', name: 'scale', masteryThreshold: 50 } });
    await db.subject.create({ data: { id: 'math', name: '数学', stage: 'junior_high', subjectKey: 'math', userId: 'scale-user' } });
    const child = await db.learner.create({ data: { userId: 'scale-user', kind: 'child', name: '孩子' } });
    childId = child.id;

    const selfIds = await seedItems('self', ITEM_COUNT, null);
    await seedItems('child', CHILD_ITEM_COUNT, childId);

    // 标签统计与薄弱点按标签聚合，至少要有标签才能走到该路径
    await db.knowledgeTag.create({ data: { id: 'tag-algebra', name: '方程', subject: 'math', userId: 'scale-user' } });
    await db.errorItem.update({ where: { id: selfIds[0] }, data: { tags: { connect: { id: 'tag-algebra' } } } });
}, 180000);

afterAll(async () => {
    await testDb.cleanup();
});

async function okJson(response: Response) {
    if (response.status !== 200) {
        throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

describe(`错题超过 999 道（本人 ${ITEM_COUNT} 道、孩子 ${CHILD_ITEM_COUNT} 道）时`, () => {
    it('今日复习能列出全部到期错题，并能翻页与按错题本筛选', async () => {
        const data = await okJson(await REVIEW_DUE(new Request('http://localhost/api/review/due')));
        expect(data.total).toBe(ITEM_COUNT);
        expect(data.items).toHaveLength(18);

        const page = await okJson(await REVIEW_DUE(new Request('http://localhost/api/review/due?page=2&pageSize=100&subjectId=math')));
        expect(page).toMatchObject({ total: ITEM_COUNT, page: 2, pageSize: 100 });
        expect(page.items).toHaveLength(100);

        const child = await okJson(await REVIEW_DUE(new Request(`http://localhost/api/review/due?learnerId=${childId}&pageSize=1000`)));
        expect(child.total).toBe(CHILD_ITEM_COUNT);
        expect(child.items).toHaveLength(1000);
    }, 60000);

    it('错题列表一页 1000 道正常返回', async () => {
        // 不带 learnerId 时列出账号下全部学习者的错题
        const all = await okJson(await LIST_ERROR_ITEMS(new Request('http://localhost/api/error-items/list?pageSize=1000&page=3')));
        expect(all.total).toBe(ITEM_COUNT + CHILD_ITEM_COUNT);
        expect(all.items).toHaveLength(ITEM_COUNT + CHILD_ITEM_COUNT - 2000);
        const data = await okJson(await LIST_ERROR_ITEMS(new Request('http://localhost/api/error-items/list?pageSize=1000&learnerId=self')));
        expect(data.total).toBe(ITEM_COUNT);
        expect(data.items).toHaveLength(1000);
        expect(data.items[0].masteryStatus).toBe('reviewing');
    }, 60000);

    it('打印视图一页 1000 道正常返回（本人与孩子）', async () => {
        const self = await okJson(await LIST_ERROR_ITEMS(new Request('http://localhost/api/error-items/list?view=print&pageSize=1000&learnerId=self')));
        expect(self.items).toHaveLength(1000);
        const child = await okJson(await LIST_ERROR_ITEMS(new Request(`http://localhost/api/error-items/list?view=print&pageSize=1000&learnerId=${childId}`)));
        expect(child.items).toHaveLength(1000);
        expect(child.total).toBe(CHILD_ITEM_COUNT);
    }, 60000);

    it('练习统计、反复错题榜、标签统计、学情分析与薄弱点接口正常返回', async () => {
        const practice = await okJson(await PRACTICE_STATS(new Request('http://localhost/api/stats/practice')));
        expect(practice.overallStats.total).toBe(ITEM_COUNT + 20);

        const repeated = await okJson(await REPEATED_MISTAKES(new Request(`http://localhost/api/stats/repeated-mistakes?learnerId=${childId}`)));
        expect(repeated.items).toHaveLength(10);
        expect(repeated.items.every((item: { wrongCount: number }) => item.wrongCount === 2)).toBe(true);

        await okJson(await TAG_STATS(new Request('http://localhost/api/tags/stats')));
        await okJson(await ANALYTICS(new Request('http://localhost/api/analytics')));
        await okJson(await WEAKNESS(new Request('http://localhost/api/variants/weakness?subjectId=math')));
    }, 60000);
});
