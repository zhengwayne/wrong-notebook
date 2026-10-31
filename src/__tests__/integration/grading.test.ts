/**
 * 收卷拍照改卷 API：新建任务、上传答卷、老师改判、确认导入错题
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    consumeAiQuota: vi.fn(),
    scheduleGrading: vi.fn(),
    confirmSubmission: vi.fn(),
    buildKeyFromExam: vi.fn(),
    classFindFirst: vi.fn(),
    taskCreate: vi.fn(),
    taskFindFirst: vi.fn(),
    submissionCreate: vi.fn(),
    submissionFindFirst: vi.fn(),
    submissionUpdate: vi.fn(),
    resultUpdate: vi.fn(),
    studentFindFirst: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        gradingClass: { findFirst: mocks.classFindFirst },
        gradingTask: { create: mocks.taskCreate, findFirst: mocks.taskFindFirst },
        gradingSubmission: { create: mocks.submissionCreate, findFirst: mocks.submissionFindFirst, update: mocks.submissionUpdate },
        gradingResult: { update: mocks.resultUpdate },
        gradingStudent: { findFirst: mocks.studentFindFirst },
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: mocks.consumeAiQuota }));
vi.mock('@/lib/grading-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/grading-service')>()),
    scheduleGrading: mocks.scheduleGrading,
    confirmSubmission: mocks.confirmSubmission,
    buildKeyFromExam: mocks.buildKeyFromExam,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST as createTask } from '@/app/api/grading/tasks/route';
import { POST as uploadPapers } from '@/app/api/grading/tasks/[id]/submissions/route';
import { PATCH as patchSubmission } from '@/app/api/grading/submissions/[id]/route';
import { POST as confirm } from '@/app/api/grading/submissions/[id]/confirm/route';

const json = (body: unknown, method = 'POST') => new Request('http://localhost/api', { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const IMAGE = 'data:image/jpeg;base64,/9j/AAAA';

const keyRow = (id: string, number: string, maxScore: number) => ({
    id, number, maxScore, order: 0, type: 'objective', answer: 'A', acceptedAnswers: null, questionText: null, knowledgePoints: null,
});
const submissionRow = () => ({
    id: 'p1', studentId: null, detectedName: null, status: 'graded', totalScore: 0, error: null, importedCount: 0, images: JSON.stringify([IMAGE]),
    task: { id: 't1', classId: 'c1', title: '单元测' }, student: null,
    results: [
        { id: 'r1', score: 0, verdict: 'wrong', keyQuestion: keyRow('k1', '1', 2) },
        { id: 'r2', score: 3, verdict: 'correct', keyQuestion: keyRow('k2', '2', 3) },
    ],
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'u1', role: 'user' });
    mocks.consumeAiQuota.mockResolvedValue(null);
    mocks.transaction.mockResolvedValue([]);
});

describe('POST /api/grading/tasks', () => {
    it('未登录返回 401', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        expect((await createTask(json({}))).status).toBe(401);
    });

    it('解析快速录入的答案并创建任务', async () => {
        mocks.classFindFirst.mockResolvedValue({ id: 'c1' });
        mocks.taskCreate.mockResolvedValue({ id: 't1' });
        const response = await createTask(json({ title: '单元测', classId: 'c1', keyText: '1-3 ABC\n4 主观 10 要点', defaultScore: 2 }));
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ id: 't1', questionCount: 4 });
        const created = mocks.taskCreate.mock.calls[0][0].data.questions.create;
        expect(created).toHaveLength(4);
        expect(created[3]).toMatchObject({ type: 'subjective', maxScore: 10 });
    });

    it('答案行无法识别时返回 400 和行号', async () => {
        mocks.classFindFirst.mockResolvedValue({ id: 'c1' });
        const response = await createTask(json({ title: 'x', classId: 'c1', keyText: '1 A\n乱写' }));
        expect(response.status).toBe(400);
        expect(JSON.stringify(await response.json())).toContain('"lines":[2]');
        expect(mocks.taskCreate).not.toHaveBeenCalled();
    });

    it('班级不属于当前老师时返回 404', async () => {
        mocks.classFindFirst.mockResolvedValue(null);
        expect((await createTask(json({ title: 'x', classId: 'c9', keyText: '1 A' }))).status).toBe(404);
    });
});

describe('POST /api/grading/tasks/:id/submissions', () => {
    const task = { id: 't1', class: { students: [{ id: 's1' }] }, _count: { questions: 3 } };

    it('逐份扣额度、创建答卷并在后台判分', async () => {
        mocks.taskFindFirst.mockResolvedValue(task);
        mocks.submissionCreate.mockResolvedValueOnce({ id: 'p1' }).mockResolvedValueOnce({ id: 'p2' });
        const response = await uploadPapers(json({ papers: [{ images: [IMAGE, IMAGE], studentId: 's1' }, { images: [IMAGE] }], language: 'zh' }), params('t1'));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ ids: ['p1', 'p2'], skipped: 0 });
        expect(mocks.consumeAiQuota).toHaveBeenCalledTimes(2);
        expect(mocks.scheduleGrading).toHaveBeenCalledWith(['p1', 'p2'], 'zh');
    });

    it('拒绝非图片数据和不在班级的学生', async () => {
        mocks.taskFindFirst.mockResolvedValue(task);
        expect((await uploadPapers(json({ papers: [{ images: ['data:text/html;base64,AAAA'] }] }), params('t1'))).status).toBe(400);
        expect((await uploadPapers(json({ papers: [{ images: [IMAGE], studentId: 'other' }] }), params('t1'))).status).toBe(400);
        expect(mocks.submissionCreate).not.toHaveBeenCalled();
    });

    it('答案为空时不能上传', async () => {
        mocks.taskFindFirst.mockResolvedValue({ ...task, _count: { questions: 0 } });
        expect((await uploadPapers(json({ papers: [{ images: [IMAGE] }] }), params('t1'))).status).toBe(400);
    });
});

describe('PATCH /api/grading/submissions/:id', () => {
    it('老师一键判对后重新计算总分', async () => {
        mocks.submissionFindFirst.mockResolvedValue(submissionRow());
        mocks.resultUpdate.mockReturnValue('update-r1');
        mocks.submissionUpdate.mockReturnValue('update-p1');
        const response = await patchSubmission(json({ results: [{ id: 'r1', verdict: 'correct' }] }, 'PATCH'), params('p1'));
        expect(response.status).toBe(200);
        expect(mocks.resultUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { verdict: 'correct', score: 2, source: 'teacher' } });
        expect(mocks.submissionUpdate).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { totalScore: 5 } });
    });

    it('指定不在班级的学生返回 400', async () => {
        mocks.submissionFindFirst.mockResolvedValue(submissionRow());
        mocks.studentFindFirst.mockResolvedValue(null);
        expect((await patchSubmission(json({ studentId: 's9' }, 'PATCH'), params('p1'))).status).toBe(400);
    });

    it('其他老师的答卷返回 404', async () => {
        mocks.submissionFindFirst.mockResolvedValue(null);
        expect((await patchSubmission(json({}, 'PATCH'), params('p1'))).status).toBe(404);
    });
});

describe('POST /api/grading/submissions/:id/confirm', () => {
    it('返回导入错题数', async () => {
        mocks.confirmSubmission.mockResolvedValue({ importedCount: 2 });
        const response = await confirm(json({}), params('p1'));
        expect(await response.json()).toEqual({ importedCount: 2 });
        expect(mocks.confirmSubmission).toHaveBeenCalledWith('p1', 'u1');
    });

    it('未指定学生时返回 400', async () => {
        mocks.confirmSubmission.mockRejectedValue(new Error('STUDENT_REQUIRED'));
        expect((await confirm(json({}), params('p1'))).status).toBe(400);
    });
});
