/**
 * 名册导入、卷头识别、答卷拆分与合并 API
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    consumeAiQuota: vi.fn(),
    scheduleGrading: vi.fn(),
    readExamPaper: vi.fn(),
    classFindMany: vi.fn(),
    classCreate: vi.fn(),
    studentFindMany: vi.fn(),
    studentCreate: vi.fn(),
    studentUpdate: vi.fn(),
    taskFindFirst: vi.fn(),
    submissionFindFirst: vi.fn(),
    submissionFindMany: vi.fn(),
    submissionCreate: vi.fn(),
    submissionUpdate: vi.fn(),
    submissionDelete: vi.fn(),
    resultDeleteMany: vi.fn(),
    transaction: vi.fn(),
}));

const tx = {
    gradingClass: { create: mocks.classCreate },
    gradingStudent: { create: mocks.studentCreate, update: mocks.studentUpdate },
    gradingSubmission: { create: mocks.submissionCreate, update: mocks.submissionUpdate },
    gradingResult: { deleteMany: mocks.resultDeleteMany },
};

vi.mock('@/lib/prisma', () => ({
    prisma: {
        gradingClass: { findMany: mocks.classFindMany },
        gradingStudent: { findMany: mocks.studentFindMany },
        gradingTask: { findFirst: mocks.taskFindFirst },
        gradingSubmission: { findFirst: mocks.submissionFindFirst, findMany: mocks.submissionFindMany, update: mocks.submissionUpdate, delete: mocks.submissionDelete },
        gradingResult: { deleteMany: mocks.resultDeleteMany },
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: mocks.consumeAiQuota }));
vi.mock('@/lib/ai', () => ({ getAIService: () => ({ readExamPaper: mocks.readExamPaper }) }));
vi.mock('@/lib/grading-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/grading-service')>()),
    scheduleGrading: mocks.scheduleGrading,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST as importRoster } from '@/app/api/grading/roster/import/route';
import { POST as identify } from '@/app/api/grading/tasks/[id]/identify/route';
import { POST as split } from '@/app/api/grading/submissions/[id]/split/route';
import { POST as merge } from '@/app/api/grading/submissions/[id]/merge/route';

const json = (body: unknown) => new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const IMAGE = 'data:image/jpeg;base64,/9j/AAAA';

const existingClasses = [
    { id: 'c1', name: '七年级1班', students: [
        { id: 's1', name: '张三', studentNo: '01', classId: 'c1', order: 0 },
        { id: 's2', name: '李四', studentNo: null, classId: 'c1', order: 1 },
    ] },
];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'u1', role: 'user' });
    mocks.consumeAiQuota.mockResolvedValue(null);
    mocks.classFindMany.mockResolvedValue(existingClasses);
    mocks.classCreate.mockResolvedValue({ id: 'c-new' });
    mocks.submissionFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (arg: unknown) => (typeof arg === 'function' ? arg(tx) : arg));
    mocks.studentFindMany.mockResolvedValue([
        { id: 's1', name: '张三', studentNo: '01', classId: 'c1', class: { name: '七年级1班' } },
        { id: 's2', name: '李四', studentNo: '02', classId: 'c1', class: { name: '七年级1班' } },
    ]);
});

describe('POST /api/grading/roster/import', () => {
    const text = '班级\t学号\t姓名\n七年级1班\t01\t张三丰\n七年级1班\t02\t李四\n七年级2班\t01\t王五\n七年级2班\t01\t王五\n七年级2班\t\t';

    it('未登录返回 401', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        expect((await importRoster(json({ text }))).status).toBe(401);
    });

    it('缺少内容返回 400', async () => {
        expect((await importRoster(json({ commit: true }))).status).toBe(400);
    });

    it('预览：新增、更新、新班级、重复与错误，不写库', async () => {
        const response = await importRoster(json({ text }));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.hasHeader).toBe(true);
        expect(body.counts).toEqual({ create: 1, update: 2, unchanged: 0 });
        expect(body.newClasses).toEqual(['七年级2班']);
        expect(body.duplicates).toHaveLength(1);
        expect(body.errors.map((item: { code: string }) => item.code)).toEqual(['missing_name']);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('确认导入：建新班、按班级+学号更新、按姓名补学号', async () => {
        const response = await importRoster(json({ text, commit: true }));
        expect(response.status).toBe(200);
        expect((await response.json()).committed).toBe(true);
        expect(mocks.classCreate).toHaveBeenCalledWith({ data: { userId: 'u1', name: '七年级2班' }, select: { id: true } });
        expect(mocks.studentUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { name: '张三丰', studentNo: '01' } });
        expect(mocks.studentUpdate).toHaveBeenCalledWith({ where: { id: 's2' }, data: { name: '李四', studentNo: '02' } });
        expect(mocks.studentCreate).toHaveBeenCalledWith({ data: { classId: 'c-new', name: '王五', studentNo: '01', order: 0 } });
    });

    it('Excel 解析出的行同样可以导入，没有班级列时用默认班级', async () => {
        const response = await importRoster(json({ rows: [['学号', '姓名'], ['3', '赵六']], defaultClassName: '七年级1班', commit: true }));
        expect(response.status).toBe(200);
        expect(mocks.studentCreate).toHaveBeenCalledWith({ data: { classId: 'c1', name: '赵六', studentNo: '3', order: 2 } });
    });

    it('没有有效行时不能确认', async () => {
        expect((await importRoster(json({ text: '姓名\n', commit: true }))).status).toBe(400);
    });

    it('学号冲突返回 409', async () => {
        mocks.transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
        expect((await importRoster(json({ text, commit: true }))).status).toBe(409);
    });
});

describe('POST /api/grading/tasks/:id/identify', () => {
    const task = { id: 't1', classId: 'c1', extraClassIds: null, userId: 'u1' };

    it('读到卷头时返回匹配结果，并提示该学生已交卷', async () => {
        mocks.taskFindFirst.mockResolvedValue(task);
        mocks.submissionFindMany.mockResolvedValue([{ studentId: 's2' }]);
        mocks.readExamPaper.mockResolvedValue({ className: '七年级1班', studentNo: '02', studentName: '李四', questions: [] });
        const response = await identify(json({ image: IMAGE }), params('t1'));
        const body = await response.json();
        expect(mocks.readExamPaper.mock.calls[0][0].mode).toBe('identify');
        expect(body.match).toMatchObject({ status: 'matched', studentId: 's2', reason: 'class_no' });
        expect(body.alreadySubmitted).toBe(true);
    });

    it('背面等没有卷头的页返回 match 为 null', async () => {
        mocks.taskFindFirst.mockResolvedValue(task);
        mocks.readExamPaper.mockResolvedValue({ className: null, studentNo: null, studentName: null, questions: [] });
        const body = await (await identify(json({ image: IMAGE }), params('t1'))).json();
        expect(body).toEqual({ identity: { className: null, studentNo: null, name: null }, match: null, alreadySubmitted: false });
    });

    it('超出额度时不调用 AI', async () => {
        mocks.taskFindFirst.mockResolvedValue(task);
        mocks.consumeAiQuota.mockResolvedValue(new Response(null, { status: 429 }));
        expect((await identify(json({ image: IMAGE }), params('t1'))).status).toBe(429);
        expect(mocks.readExamPaper).not.toHaveBeenCalled();
    });

    it('其他老师的任务返回 404', async () => {
        mocks.taskFindFirst.mockResolvedValue(null);
        expect((await identify(json({ image: IMAGE }), params('t1'))).status).toBe(404);
    });
});

describe('拆分与合并答卷', () => {
    const paper = (id: string, pages: number, status = 'graded') => ({ id, taskId: 't1', status, images: JSON.stringify(Array(pages).fill(IMAGE)) });

    it('从第 2 张起拆出新的一份，两份都重新判分', async () => {
        mocks.submissionFindFirst.mockResolvedValue(paper('p1', 3));
        mocks.submissionCreate.mockResolvedValue({ id: 'p2' });
        const response = await split(json({ fromPage: 1 }), params('p1'));
        expect(response.status).toBe(201);
        expect(JSON.parse(mocks.submissionUpdate.mock.calls[0][0].data.images)).toHaveLength(1);
        expect(JSON.parse(mocks.submissionCreate.mock.calls[0][0].data.images)).toHaveLength(2);
        expect(mocks.scheduleGrading).toHaveBeenCalledWith(['p1', 'p2'], 'zh');
    });

    it('拆分位置超出页数返回 400，已确认的答卷返回 409', async () => {
        mocks.submissionFindFirst.mockResolvedValue(paper('p1', 1));
        expect((await split(json({ fromPage: 1 }), params('p1'))).status).toBe(400);
        mocks.submissionFindFirst.mockResolvedValue(paper('p1', 3, 'confirmed'));
        expect((await split(json({ fromPage: 1 }), params('p1'))).status).toBe(409);
    });

    it('并入上一份：页接在后面并删除这份', async () => {
        mocks.submissionFindFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(where.id === 'p2' ? paper('p2', 1) : paper('p1', 1)));
        mocks.submissionUpdate.mockReturnValue('u');
        mocks.submissionDelete.mockReturnValue('d');
        mocks.resultDeleteMany.mockReturnValue('r');
        const response = await merge(json({ targetId: 'p1' }), params('p2'));
        expect(response.status).toBe(200);
        expect(JSON.parse(mocks.submissionUpdate.mock.calls[0][0].data.images)).toHaveLength(2);
        expect(mocks.submissionDelete).toHaveBeenCalledWith({ where: { id: 'p2' } });
        expect(mocks.scheduleGrading).toHaveBeenCalledWith(['p1'], 'zh');
    });

    it('不能并入自己或已确认的答卷', async () => {
        expect((await merge(json({ targetId: 'p1' }), params('p1'))).status).toBe(400);
        mocks.submissionFindFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(where.id === 'p1' ? paper('p1', 1, 'confirmed') : paper('p2', 1)));
        expect((await merge(json({ targetId: 'p1' }), params('p2'))).status).toBe(409);
    });
});
