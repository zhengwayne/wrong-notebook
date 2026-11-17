// @vitest-environment node
/**
 * OPT-07 & OPT-21 多孩子学习者作用域全链路隔离、并发竞态与原子归档/删除集成测试。
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_PNG_BASE64 } from '../helpers/sample-images';
import { createIsolatedTestDb, expectCrossScopeNotFound, withTwoTenants, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as { user: { id: string; email: string; name: string; role: string }; expires: string } | null,
    scheduleMasteryEvaluation: vi.fn(),
    scheduleLearningPathReplan: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: mocks.scheduleMasteryEvaluation,
}));
vi.mock('@/lib/learning-path/service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/learning-path/service')>()),
    scheduleLearningPathReplan: mocks.scheduleLearningPathReplan,
}));

import { GET as GET_ANALYTICS } from '@/app/api/analytics/route';
import { DELETE as CLEAR_ERROR_ITEMS } from '@/app/api/error-items/clear/route';
import { GET as LIST_ERROR_ITEMS } from '@/app/api/error-items/list/route';
import { POST as CREATE_ERROR_ITEM } from '@/app/api/error-items/route';
import { GET as GET_LEARNERS, POST as CREATE_LEARNER } from '@/app/api/learners/route';
import { DELETE as DELETE_CHILD } from '@/app/api/learners/[id]/route';
import { GET as GET_NOTEBOOK } from '@/app/api/notebooks/[id]/route';
import { GET as GET_NOTEBOOKS } from '@/app/api/notebooks/route';
import { POST as OPENCLAW_UPLOAD } from '@/app/api/openclaw/batch-upload/route';
import { POST as RECORD_PRACTICE } from '@/app/api/practice/record/route';
import { GET as GET_REVIEW_DUE } from '@/app/api/review/due/route';
import { DELETE as CLEAR_PRACTICE } from '@/app/api/stats/practice/clear/route';
import { GET as GET_PRACTICE_STATS } from '@/app/api/stats/practice/route';
import { GET as GET_TAGS_STATS } from '@/app/api/tags/stats/route';
import { recordExamResults } from '@/lib/exam';

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb('learner-isolation-');
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.session = null;
    await db.learnerBackfillAudit.deleteMany();
    await db.learningPathStep.deleteMany();
    await db.learningPath.deleteMany();
    await db.knowledgeMastery.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.practiceRecord.deleteMany();
    await db.examQuestion.deleteMany();
    await db.examPaper.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const jsonPost = (url: string, body: object, headers?: Record<string, string>) => new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
});

describe('多孩子学习者全链路作用域隔离（OPT-07 + OPT-21）', () => {
    it('双账户 × 双孩子 × 本人 × 跨班同名学生全链路判重、统计、复习与清空完全隔离', async () => {
        await withTwoTenants(db, async ({ alice, bob }) => {
            const sameQuestion = '已知一次函数 y = 2x + 1，求当 x = 3 时 y 的值。';

            await db.knowledgeTag.createMany({
                data: [
                    { id: 'tag-fn', name: '一次函数', subject: 'math', isSystem: true, order: 1 },
                    { id: 'tag-eq', name: '一元一次方程', subject: 'math', isSystem: true, order: 2 },
                ],
            });

            // 1. Alice 为本人、孩子1（小明）、孩子2（小红）分别录入完全相同的题目，互不触发判重
            mocks.session = alice.session;

            const aliceSelfCreate = await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: alice.notebook.id,
                questionText: sameQuestion,
                answerText: 'y = 7',
                knowledgePoints: ['一次函数'],
                originalImageUrl: '',
            }));
            expect(aliceSelfCreate.status).toBe(201);
            const aliceSelfItem = await aliceSelfCreate.json();
            expect(aliceSelfItem.learnerId).toBeNull();

            const aliceChild1Create = await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: alice.notebook.id,
                learnerId: alice.children.first.id,
                questionText: sameQuestion,
                answerText: 'y = 7',
                knowledgePoints: ['一次函数'],
                originalImageUrl: '',
            }));
            expect(aliceChild1Create.status).toBe(201);
            const aliceChild1Item = await aliceChild1Create.json();
            expect(aliceChild1Item.learnerId).toBe(alice.children.first.id);
            expect(aliceChild1Item.id).not.toBe(aliceSelfItem.id);

            const aliceChild2Create = await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: alice.notebook.id,
                learnerId: alice.children.second.id,
                questionText: '解方程 3x - 6 = 0。',
                answerText: 'x = 2',
                knowledgePoints: ['一元一次方程'],
                originalImageUrl: '',
            }));
            expect(aliceChild2Create.status).toBe(201);
            const aliceChild2Item = await aliceChild2Create.json();

            // 孩子1 再录一次相同题目 -> 命中孩子1自身判重，PracticeRecord.learnerId 必须写入孩子1
            const child1Dup = await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: alice.notebook.id,
                learnerId: alice.children.first.id,
                questionText: sameQuestion,
                answerText: 'y = 7',
                wrongAnswerText: '6',
                originalImageUrl: '',
            }));
            expect(child1Dup.status).toBe(200);
            const child1DupBody = await child1Dup.json();
            expect(child1DupBody.duplicate).toBe(true);
            expect(child1DupBody.id).toBe(aliceChild1Item.id);
            const dupRecord = await db.practiceRecord.findUnique({ where: { id: child1DupBody.practiceRecordId } });
            expect(dupRecord?.learnerId).toBe(alice.children.first.id);

            // 2. Openclaw 批量上传也遵循学习者作用域隔离
            vi.stubEnv('OPENCLAW_AUTH_MODE', 'apikey');
            vi.stubEnv('OPENCLAW_INTEGRATION_API_KEY', 'oc-test-key');
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
                success: true,
                data: { questionText: sameQuestion, answerText: 'y = 7', analysis: '代入计算', knowledgePoints: [] },
            }), { status: 200 })));

            // 对孩子1 上传 -> 命中孩子1判重，产生第 2 条孩子1重复练习记录
            const ocChild1 = await OPENCLAW_UPLOAD(jsonPost('/api/openclaw/batch-upload', {
                userEmail: alice.user.email,
                subjectId: alice.notebook.id,
                learnerId: alice.children.first.id,
                images: [{ base64: SAMPLE_PNG_BASE64, mimeType: 'image/png', filename: 'q1.png' }],
            }, { 'x-api-key': 'oc-test-key' }));
            expect(ocChild1.status).toBe(201);
            const ocChild1Json = await ocChild1.json();
            expect(ocChild1Json.results[0].duplicate).toBe(true);
            expect(ocChild1Json.results[0].errorItemId).toBe(aliceChild1Item.id);

            // 对跨班同名学生 A（张三·一班）vs 学生 B（张三·二班）分别上传同题 -> 互相隔离各建一题
            const ocStuA = await OPENCLAW_UPLOAD(jsonPost('/api/openclaw/batch-upload', {
                userEmail: alice.user.email,
                subjectId: alice.notebook.id,
                learnerId: alice.sameNameStudents.inClassA.learnerId,
                images: [{ base64: SAMPLE_PNG_BASE64, mimeType: 'image/png', filename: 'a.png' }],
            }, { 'x-api-key': 'oc-test-key' }));
            expect(ocStuA.status).toBe(201);
            const ocStuAJson = await ocStuA.json();
            expect(ocStuAJson.results[0].duplicate).toBeUndefined();

            const ocStuB = await OPENCLAW_UPLOAD(jsonPost('/api/openclaw/batch-upload', {
                userEmail: alice.user.email,
                subjectId: alice.notebook.id,
                learnerId: alice.sameNameStudents.inClassB.learnerId,
                images: [{ base64: SAMPLE_PNG_BASE64, mimeType: 'image/png', filename: 'b.png' }],
            }, { 'x-api-key': 'oc-test-key' }));
            expect(ocStuB.status).toBe(201);
            const ocStuBJson = await ocStuB.json();
            expect(ocStuBJson.results[0].duplicate).toBeUndefined();
            expect(ocStuBJson.results[0].errorItemId).not.toBe(ocStuAJson.results[0].errorItemId);

            // 3. Bob 在自己账户为同名孩子“小明”录入完全相同的题目，互不干扰
            mocks.session = bob.session;
            const bobChild1Create = await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: bob.notebook.id,
                learnerId: bob.children.first.id,
                questionText: sameQuestion,
                answerText: 'y = 7',
                knowledgePoints: ['一次函数'],
                originalImageUrl: '',
            }));
            expect(bobChild1Create.status).toBe(201);
            const bobChild1Item = await bobChild1Create.json();
            expect(bobChild1Item.learnerId).toBe(bob.children.first.id);

            // 4. 练习记录与试卷作答自动继承原题 learnerId，禁止跨学习者写入练习
            mocks.session = alice.session;
            const crossPractice = await RECORD_PRACTICE(jsonPost('/api/practice/record', {
                errorItemId: aliceChild1Item.id,
                learnerId: alice.children.second.id,
                result: 'correct',
            }));
            expectCrossScopeNotFound(crossPractice);

            const child2Practice = await RECORD_PRACTICE(jsonPost('/api/practice/record', {
                errorItemId: aliceChild2Item.id,
                result: 'correct',
            }));
            expect(child2Practice.status).toBe(200);
            expect((await child2Practice.json()).learnerId).toBe(alice.children.second.id);

            const examPaper = await db.examPaper.create({
                data: {
                    id: 'exam-child1',
                    userId: alice.user.id,
                    title: '小明练习卷',
                    status: 'ready',
                    scope: 'unmastered',
                    difficulty: 'medium',
                    requestedCount: 1,
                    subjectIds: JSON.stringify([alice.notebook.id]),
                    questions: {
                        create: {
                            id: 'eq-child1',
                            order: 1,
                            errorItemId: aliceChild1Item.id,
                            sourceShortId: aliceChild1Item.shortId || 'S1',
                            status: 'ready',
                            questionText: sameQuestion,
                        },
                    },
                },
            });
            await recordExamResults(examPaper.id, alice.user.id, new Date(), [{ questionId: 'eq-child1', result: 'correct' }]);
            const examPractice = await db.practiceRecord.findFirst({
                where: { examQuestionId: 'eq-child1' },
            });
            expect(examPractice?.learnerId).toBe(alice.children.first.id);

            // 5. 统计、标签频率、待复习列表与错题本计数按作用域严格隔离
            const selfAnalytics = await GET_ANALYTICS(new Request('http://localhost/api/analytics'));
            expect((await selfAnalytics.json()).totalErrors).toBe(1);

            const child1Analytics = await GET_ANALYTICS(new Request(`http://localhost/api/analytics?learnerId=${alice.children.first.id}`));
            expect((await child1Analytics.json()).totalErrors).toBe(1);

            const selfPracticeStats = await GET_PRACTICE_STATS(new Request('http://localhost/api/stats/practice'));
            expect((await selfPracticeStats.json()).overallStats.total).toBe(0);

            const child1PracticeStats = await GET_PRACTICE_STATS(new Request(`http://localhost/api/stats/practice?learnerId=${alice.children.first.id}`));
            // 孩子1 有 2 次判重错题快照 + 1 次试卷作答 = 3 次
            expect((await child1PracticeStats.json()).overallStats.total).toBe(3);

            const child2PracticeStats = await GET_PRACTICE_STATS(new Request(`http://localhost/api/stats/practice?learnerId=${alice.children.second.id}`));
            expect((await child2PracticeStats.json()).overallStats.total).toBe(1);

            const child1Tags = await (await GET_TAGS_STATS(new Request(`http://localhost/api/tags/stats?learnerId=${alice.children.first.id}`))).json();
            expect(child1Tags.total).toBe(1);
            expect(child1Tags.stats).toEqual([{ tag: '一次函数', count: 1 }]);

            const child2Tags = await (await GET_TAGS_STATS(new Request(`http://localhost/api/tags/stats?learnerId=${alice.children.second.id}`))).json();
            expect(child2Tags.total).toBe(1);
            expect(child2Tags.stats).toEqual([{ tag: '一元一次方程', count: 1 }]);

            const selfDue = await (await GET_REVIEW_DUE(new Request('http://localhost/api/review/due?learnerId=self'))).json();
            expect(selfDue.items.map((i: { id: string }) => i.id)).toEqual([aliceSelfItem.id]);

            const child2Due = await (await GET_REVIEW_DUE(new Request(`http://localhost/api/review/due?learnerId=${alice.children.second.id}`))).json();
            // 孩子2 今天刚刚答对一次 -> 次日到期，当前队列应为 0；不会误读孩子1 的做错记录
            expect(child2Due.total).toBe(0);

            // 6. 跨账户使用他人 learnerId 访问任何接口必须返回 404
            expectCrossScopeNotFound(await CREATE_ERROR_ITEM(jsonPost('/api/error-items', {
                subjectId: alice.notebook.id,
                learnerId: bob.children.first.id,
                questionText: '越权测试',
                originalImageUrl: '',
            })));
            expectCrossScopeNotFound(await OPENCLAW_UPLOAD(jsonPost('/api/openclaw/batch-upload', {
                userEmail: alice.user.email,
                learnerId: bob.children.first.id,
                images: [{ base64: SAMPLE_PNG_BASE64, mimeType: 'image/png', filename: 'x.png' }],
            }, { 'x-api-key': 'oc-test-key' })));
            expectCrossScopeNotFound(await GET_ANALYTICS(new Request(`http://localhost/api/analytics?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await GET_PRACTICE_STATS(new Request(`http://localhost/api/stats/practice?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await GET_TAGS_STATS(new Request(`http://localhost/api/tags/stats?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await GET_REVIEW_DUE(new Request(`http://localhost/api/review/due?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await CLEAR_PRACTICE(new Request(`http://localhost/api/stats/practice/clear?learnerId=${bob.children.first.id}`, { method: 'DELETE' })));
            expectCrossScopeNotFound(await CLEAR_ERROR_ITEMS(new Request(`http://localhost/api/error-items/clear?learnerId=${bob.children.first.id}`, { method: 'DELETE' })));
            expectCrossScopeNotFound(await LIST_ERROR_ITEMS(new Request(`http://localhost/api/error-items/list?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await GET_NOTEBOOKS(new Request(`http://localhost/api/notebooks?learnerId=${bob.children.first.id}`)));
            expectCrossScopeNotFound(await GET_NOTEBOOK(new Request(`http://localhost/api/notebooks/${alice.notebook.id}?learnerId=${bob.children.first.id}`), { params: Promise.resolve({ id: alice.notebook.id }) }));

            // 7. 清空孩子1 的练习记录与错题，只清理孩子1，Alice 本人/孩子2/同名学生及 Bob 完全不受影响
            const clearedChild1Pr = await CLEAR_PRACTICE(new Request(`http://localhost/api/stats/practice/clear?learnerId=${alice.children.first.id}`, { method: 'DELETE' }));
            expect(clearedChild1Pr.status).toBe(200);
            expect(await db.practiceRecord.count({ where: { userId: alice.user.id, learnerId: alice.children.first.id } })).toBe(0);
            expect(await db.practiceRecord.count({ where: { userId: alice.user.id, learnerId: alice.children.second.id } })).toBe(1);

            const clearedChild1Errors = await CLEAR_ERROR_ITEMS(new Request(`http://localhost/api/error-items/clear?learnerId=${alice.children.first.id}`, { method: 'DELETE' }));
            expect(clearedChild1Errors.status).toBe(200);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: alice.children.first.id } })).toBe(0);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: null } })).toBe(1);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: alice.children.second.id } })).toBe(1);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: alice.sameNameStudents.inClassA.learnerId } })).toBe(1);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: alice.sameNameStudents.inClassB.learnerId } })).toBe(1);
            expect(await db.errorItem.count({ where: { userId: bob.user.id, learnerId: bob.children.first.id } })).toBe(1);

            // 8. 软归档孩子后，再以其 learnerId 查询统计/录题均返回 404，而其历史错题留存且不混入本人
            const archiveChild2 = await DELETE_CHILD(new Request(`http://localhost/api/learners/${alice.children.second.id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleteQuestions: false }),
            }), { params: Promise.resolve({ id: alice.children.second.id }) });
            expect(archiveChild2.status).toBe(200);
            expectCrossScopeNotFound(await GET_ANALYTICS(new Request(`http://localhost/api/analytics?learnerId=${alice.children.second.id}`)));
            expect((await (await GET_ANALYTICS(new Request('http://localhost/api/analytics'))).json()).totalErrors).toBe(1);
            expect(await db.errorItem.count({ where: { userId: alice.user.id, learnerId: alice.children.second.id } })).toBe(1);
        });
    });

    it('10 个并发 POST /api/learners 创建孩子最多成功 3 个，不突破上限', async () => {
        const user = await db.user.create({
            data: {
                id: 'race-parent',
                email: 'race-parent@example.com',
                password: 'hash',
                personas: '["parent"]',
                activePersona: 'parent',
                personasConfirmedAt: new Date(),
            },
        });
        mocks.session = {
            user: { id: user.id, email: user.email, name: '并发家长', role: 'user' },
            expires: '2099-01-01',
        };

        const responses = await Promise.all(
            Array.from({ length: 10 }, (_, idx) => CREATE_LEARNER(jsonPost('/api/learners', { name: `并发孩子-${idx}` }))),
        );
        const statuses = responses.map((res) => res.status);
        expect(statuses.filter((code) => code === 201)).toHaveLength(3);
        expect(statuses.filter((code) => code === 400)).toHaveLength(7);

        const activeChildren = await db.learner.count({
            where: { userId: user.id, kind: 'child', archivedAt: null },
        });
        expect(activeChildren).toBe(3);

        const listRes = await GET_LEARNERS();
        const listJson = await listRes.json();
        expect(listJson.children).toHaveLength(3);
    });

    it('硬删除孩子在中途注入异常时全事务回滚零残留，成功后彻底清除全部关联表', async () => {
        await withTwoTenants(db, async ({ alice }) => {
            mocks.session = alice.session;
            const targetChild = alice.children.second;
            const keepChild = alice.children.first;

            // 为待删除孩子及对照组孩子同时准备全部关联数据（包含无 errorItemId 的独立练习）
            await db.errorItem.createMany({
                data: [
                    { id: 'ei-del', userId: alice.user.id, subjectId: alice.notebook.id, learnerId: targetChild.id, originalImageUrl: '', questionText: '删前错题' },
                    { id: 'ei-keep', userId: alice.user.id, subjectId: alice.notebook.id, learnerId: keepChild.id, originalImageUrl: '', questionText: '保留错题' },
                ],
            });
            await db.practiceRecord.createMany({
                data: [
                    { id: 'pr-del-linked', userId: alice.user.id, learnerId: targetChild.id, errorItemId: 'ei-del', result: 'wrong', isCorrect: false },
                    { id: 'pr-del-orphan', userId: alice.user.id, learnerId: targetChild.id, errorItemId: null, result: 'correct', isCorrect: true },
                    { id: 'pr-keep', userId: alice.user.id, learnerId: keepChild.id, errorItemId: 'ei-keep', result: 'correct', isCorrect: true },
                ],
            });
            await db.parentPaper.create({
                data: {
                    id: 'pp-del',
                    userId: alice.user.id,
                    learnerId: targetChild.id,
                    title: '待删试卷',
                    pages: { create: { id: 'ppp-del', position: 0, imageUrl: 'data:image/png;base64,AA==' } },
                    questions: { create: { id: 'ppq-del', position: 0, number: '1', verdict: 'wrong' } },
                },
            });
            await db.knowledgeMastery.createMany({
                data: [
                    { id: 'km-del', userId: alice.user.id, studentKey: targetChild.id, knowledgePoint: '函数', pKnown: 0.4 },
                    { id: 'km-keep', userId: alice.user.id, studentKey: keepChild.id, knowledgePoint: '函数', pKnown: 0.7 },
                ],
            });
            await db.learningPath.create({
                data: {
                    id: 'lp-del',
                    userId: alice.user.id,
                    studentKey: targetChild.id,
                    studentName: targetChild.name,
                    evidenceHash: 'hash-del',
                    steps: {
                        create: { id: 'lps-del', position: 0, type: 'review_explanation', title: '复习', reason: '错题', knowledgePoints: '["函数"]' },
                    },
                },
            });
            await db.learningPath.create({
                data: {
                    id: 'lp-keep',
                    userId: alice.user.id,
                    studentKey: keepChild.id,
                    studentName: keepChild.name,
                    evidenceHash: 'hash-keep',
                    steps: {
                        create: { id: 'lps-keep', position: 0, type: 'review_explanation', title: '保留复习', reason: '错题', knowledgePoints: '["函数"]' },
                    },
                },
            });

            // 通过 SQLite 触发器在事务最后一步（DELETE Learner）注入中途失败
            await db.$executeRawUnsafe(`
                CREATE TRIGGER "fail_learner_delete_for_rollback_test"
                BEFORE DELETE ON "Learner"
                WHEN OLD."id" = '${targetChild.id}'
                BEGIN
                    SELECT RAISE(ABORT, 'SIMULATED_DELETE_FAILURE');
                END;
            `);

            const failedRes = await DELETE_CHILD(new Request(`http://localhost/api/learners/${targetChild.id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleteQuestions: true, confirmDeleteQuestions: true }),
            }), { params: Promise.resolve({ id: targetChild.id }) });
            expect(failedRes.status).toBe(500);

            // 验证全部 7 张关联表在异常回滚后零半完成残留
            expect(await db.learner.findUnique({ where: { id: targetChild.id } })).not.toBeNull();
            expect(await db.errorItem.count({ where: { learnerId: targetChild.id } })).toBe(1);
            expect(await db.practiceRecord.count({ where: { learnerId: targetChild.id } })).toBe(2);
            expect(await db.parentPaper.count({ where: { learnerId: targetChild.id } })).toBe(1);
            expect(await db.knowledgeMastery.count({ where: { studentKey: targetChild.id } })).toBe(1);
            expect(await db.learningPath.count({ where: { studentKey: targetChild.id } })).toBe(1);
            expect(await db.learningPathStep.count({ where: { pathId: 'lp-del' } })).toBe(1);

            // 移除故障触发器后再次硬删除，验证彻底清理待删除孩子全部数据且零误伤其他孩子
            await db.$executeRawUnsafe('DROP TRIGGER "fail_learner_delete_for_rollback_test";');
            const okRes = await DELETE_CHILD(new Request(`http://localhost/api/learners/${targetChild.id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleteQuestions: true, confirmDeleteQuestions: true }),
            }), { params: Promise.resolve({ id: targetChild.id }) });
            expect(okRes.status).toBe(200);
            expect(await okRes.json()).toMatchObject({ ok: true, archived: false, deletedQuestions: 1 });

            expect(await db.learner.findUnique({ where: { id: targetChild.id } })).toBeNull();
            expect(await db.errorItem.count({ where: { learnerId: targetChild.id } })).toBe(0);
            expect(await db.practiceRecord.count({ where: { learnerId: targetChild.id } })).toBe(0);
            expect(await db.parentPaper.count({ where: { learnerId: targetChild.id } })).toBe(0);
            expect(await db.knowledgeMastery.count({ where: { studentKey: targetChild.id } })).toBe(0);
            expect(await db.learningPath.count({ where: { studentKey: targetChild.id } })).toBe(0);
            expect(await db.learningPathStep.count({ where: { pathId: 'lp-del' } })).toBe(0);

            // 对照组孩子的数据分毫不伤
            expect(await db.learner.findUnique({ where: { id: keepChild.id } })).not.toBeNull();
            expect(await db.errorItem.count({ where: { learnerId: keepChild.id } })).toBe(1);
            expect(await db.practiceRecord.count({ where: { learnerId: keepChild.id } })).toBe(1);
            expect(await db.knowledgeMastery.count({ where: { studentKey: keepChild.id } })).toBe(1);
            expect(await db.learningPath.count({ where: { studentKey: keepChild.id } })).toBe(1);
        });
    });
});
