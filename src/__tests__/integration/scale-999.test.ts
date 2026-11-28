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
                const base = { userId: 'scale-user', learnerId, errorItemId: id, result: 'wrong' as string | null, isCorrect: false, subject: '数学', source: 'practice' };
                // 前 20 道题做错两次进入反复错题榜；第 21 道混入历史 result=null/isCorrect=false 记录
                if (start === 0 && index < 20) {
                    return [
                        { ...base, createdAt: new Date(now - 3 * DAY) },
                        { ...base, createdAt: new Date(now - 2 * DAY) },
                    ];
                }
                if (start === 0 && index === 20) {
                    return [
                        { ...base, result: null, isCorrect: false, createdAt: new Date(now - 3 * DAY) },
                    ];
                }
                return [{ ...base, createdAt: new Date(now - 3 * DAY) }];
            }),
        });
    }
    return ids;
}

async function connectTagInBatches(tagId: string, itemIds: string[]) {
    for (let start = 0; start < itemIds.length; start += 400) {
        const slice = itemIds.slice(start, start + 400);
        await db.knowledgeTag.update({
            where: { id: tagId },
            data: { errorItems: { connect: slice.map((id) => ({ id })) } },
        });
    }
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
    const childIds = await seedItems('child', CHILD_ITEM_COUNT, childId);

    // 为超过 999 道错题建立多对多标签关联，覆盖大基数标签统计与薄弱点聚合路径
    await db.knowledgeTag.create({ data: { id: 'tag-algebra', name: '方程', subject: 'math', userId: 'scale-user' } });
    await connectTagInBatches('tag-algebra', selfIds);
    await connectTagInBatches('tag-algebra', childIds.slice(0, 100));
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

    it('练习统计、反复错题榜、标签统计、学情分析与薄弱点接口正常返回并校验真实计数', async () => {
        const practice = await okJson(await PRACTICE_STATS(new Request('http://localhost/api/stats/practice')));
        expect(practice.overallStats.total).toBe(ITEM_COUNT + 20);

        const repeated = await okJson(await REPEATED_MISTAKES(new Request(`http://localhost/api/stats/repeated-mistakes?learnerId=${childId}`)));
        expect(repeated.items).toHaveLength(10);
        expect(repeated.items.every((item: { id: string; wrongCount: number }) => item.id.startsWith('child-') && item.wrongCount === 2)).toBe(true);

        const selfTags = await okJson(await TAG_STATS(new Request('http://localhost/api/tags/stats')));
        expect(selfTags).toMatchObject({ total: ITEM_COUNT, uniqueTags: 1 });
        expect(selfTags.stats).toEqual([{ tag: '方程', count: ITEM_COUNT }]);

        const childTags = await okJson(await TAG_STATS(new Request(`http://localhost/api/tags/stats?learnerId=${childId}`)));
        expect(childTags).toMatchObject({ total: CHILD_ITEM_COUNT, uniqueTags: 1 });
        expect(childTags.stats).toEqual([{ tag: '方程', count: 100 }]);

        const analytics = await okJson(await ANALYTICS(new Request('http://localhost/api/analytics')));
        expect(analytics).toMatchObject({ totalErrors: ITEM_COUNT, masteredCount: 0 });
        expect(analytics.subjectStats).toEqual([{ name: '数学', value: ITEM_COUNT }]);

        const weakness = await okJson(await WEAKNESS(new Request('http://localhost/api/variants/weakness?subjectId=math')));
        expect(weakness.profile.itemCount).toBe(ITEM_COUNT + CHILD_ITEM_COUNT);
        expect(weakness.profile.weaknesses[0]).toMatchObject({ knowledgePoint: '方程', itemCount: ITEM_COUNT + 100 });
    }, 60000);
});
