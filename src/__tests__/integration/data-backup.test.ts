// @vitest-environment node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupManifestV3 } from '@/lib/backup/types';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    scheduleMasteryEvaluation: vi.fn(),
    session: { user: { id: 'user-1', email: 'backup-test@example.com', role: 'user' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: mocks.scheduleMasteryEvaluation,
}));

import { GET as EXPORT, POST as EXPORT_POST } from '@/app/api/export/route';
import { POST as IMPORT } from '@/app/api/import/route';
import * as archiveRead from '@/lib/backup/archive-read';
import { BackupError } from '@/lib/backup/errors';
import { flushBackgroundTasksToDb } from '@/lib/background-tasks';
import { sanitizeFigureSvg } from '@/lib/figure-svg';
import { MAX_CHILD_LEARNERS } from '@/lib/learners';
import { embedNarration, sanitizeSvgAnimation } from '@/lib/svg-animation';
import { encodeMp3 } from '@/lib/tts/mp3';

let database: PrismaClient;
let directory: string;
const figure = sanitizeFigureSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>')!;
const animation = (text: string) => sanitizeSvgAnimation(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5">${text}<animate attributeName="opacity" from="0" to="1" dur="1s"/></text></svg>`)!;
const lastPractice = JSON.stringify({ questionText: '新题', answerText: '答案', analysis: '解析', figureSvg: figure, difficulty: 'medium', generatedAt: '2026-10-20T00:00:00.000Z' });

async function exportLegacyJsonBackup() {
    const response = await EXPORT(new Request('http://localhost/api/export?format=json'));
    expect(response.status).toBe(200);
    return response.json();
}

async function exportZipBackup(query = ''): Promise<Uint8Array> {
    const response = await EXPORT(new Request(`http://localhost/api/export${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('x-backup-format-version')).toBe('3');
    return new Uint8Array(await response.arrayBuffer());
}

async function importZipBackup(zipBytes: Uint8Array, query = '', passphrase?: string) {
    const body = new Blob([Buffer.from(zipBytes)], { type: 'application/zip' });
    const form = new FormData();
    form.append('file', body, 'backup.zip');
    if (passphrase !== undefined) {
        form.append('passphrase', passphrase);
    }
    const response = await IMPORT(new Request(`http://localhost/api/import${query}`, {
        method: 'POST',
        body: form,
    }));
    return { response, data: await response.json() };
}

async function importBackup(body: object, query = '') {
    const response = await IMPORT(new Request(`http://localhost/api/import${query}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    return response.json();
}

/** 清空当前用户的学习数据（保留账户），模拟换机后导入 */
async function clearUserData() {
    await database.itemMemory.deleteMany({});
    await database.learningPathStep.deleteMany({});
    await database.learningPath.deleteMany({});
    await database.knowledgeMastery.deleteMany({});
    await database.parentPaperQuestion.deleteMany({});
    await database.parentPaperPage.deleteMany({});
    await database.parentPaper.deleteMany({});
    await database.dailyHomeworkItem.deleteMany({});
    await database.gradingResult.deleteMany({});
    await database.gradingSubmission.deleteMany({});
    await database.gradingKeyQuestion.deleteMany({});
    await database.gradingTask.deleteMany({});
    await database.gradingStudent.deleteMany({});
    await database.gradingClass.deleteMany({});
    await database.variantStageLog.deleteMany({});
    await database.variantRun.deleteMany({});
    await database.examPaper.deleteMany({});
    await database.errorItem.deleteMany({});
    await database.learner.deleteMany({});
    await database.subject.deleteMany({});
    await database.knowledgeTag.deleteMany({});
    await database.practiceRecord.deleteMany({});
    await database.aiProvenance.deleteMany({});
}

beforeAll(() => {
    // 所有真实读写和迁移均使用系统临时数据库，不接触开发或生产数据。
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-backup-test-'));
    // 云端语音缓存同样写到临时目录
    process.env.CONFIG_DIR = join(directory, 'config');
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
// 迁移通过子进程执行 Prisma CLI，CI 中与其他测试文件并行时较慢，留足时间
}, 120000);

beforeEach(async () => {
    mocks.scheduleMasteryEvaluation.mockClear();
    mocks.session = { user: { id: 'user-1', email: 'backup-test@example.com', role: 'user' }, expires: '2099-01-01' };
    await clearUserData();
    await database.user.deleteMany();
    await database.user.create({ data: { id: 'user-1', email: mocks.session.user.email, password: 'test-only' } });
    await database.subject.create({ data: { id: 'math', name: '数学', stage: 'junior_high', subjectKey: 'math', userId: 'user-1' } });
    await database.knowledgeTag.create({ data: { id: 'tag-1', name: '自定义标签', subject: 'math', userId: 'user-1' } });
    await database.aiProvenance.create({
        data: {
            id: 'prov-1',
            task: 'analyze',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            promptVersion: 'abc123def456',
            parserVersion: 'v2-latex-sm',
        },
    });
    await database.errorItem.create({
        data: {
            id: 'item-1', shortId: 'AbC234', userId: 'user-1', subjectId: 'math', originalImageUrl: 'data:image/png;base64,dGVzdA==',
            questionText: '求解 x + 2 = 5', answerText: 'x = 3', analysis: '移项', wrongAnswerText: 'x = 7', mistakeAnalysis: '符号错误',
            mistakeStatus: 'wrong_attempt', source: '期中考试', errorType: '计算', userNotes: '注意符号', gradeSemester: '初二上',
            paperLevel: 'b', difficultyStars: 3, hasFigure: true, figureSvg: figure,
            geogebraCommands: 'A=(0,0)\nB=(1,1)', svgAnimation: animation('中文'), svgAnimationEn: animation('English'), lastPractice,
            provenanceId: 'prov-1',
            masteryLevel: 2, masteryProbability: 0.8, masteryReason: '连续答对', masterySource: 'ai', masteryEvaluatedAt: new Date('2026-10-21T00:00:00Z'),
            createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-21T00:00:00Z'),
            tags: { connect: [{ id: 'tag-1' }] },
        },
    });
    await database.reviewSchedule.create({ data: { errorItemId: 'item-1', scheduledFor: new Date('2026-11-01T00:00:00Z') } });
    await database.practiceRecord.create({
        data: {
            userId: 'user-1', errorItemId: 'item-1', subject: 'math', difficulty: 'medium', isCorrect: true, result: 'correct',
            questionText: '变式题', answerText: 'x = 4', analysis: '同理', figureSvg: figure, source: 'practice',
            createdAt: new Date('2026-10-20T00:00:00Z'),
        },
    });
});

afterAll(async () => {
    // 导入接口会把后台任务状态异步写回数据库；先排空写入队列，避免断开后自动重连又建出 test.db
    await flushBackgroundTasksToDb();
    // 再摘掉应用侧 prisma，迟到的后台写入会走内存回退而不是重连 SQLite
    mocks.prisma = undefined;
    await flushBackgroundTasksToDb();
    delete process.env.CONFIG_DIR;
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('数据导出后再导入（真实 SQLite）', () => {
    it('默认导出流式 v3 ZIP，显式 ?format=json 时保留兼容第 2 版 JSON 格式', async () => {
        const zipBytes = await exportZipBackup();
        const unpacked = unzipSync(zipBytes);
        const manifest = JSON.parse(Buffer.from(unpacked['manifest.json']).toString('utf8')) as BackupManifestV3;
        expect(manifest.formatVersion).toBe(3);
        expect(manifest.warnings).toContain('BACKUP_UNENCRYPTED');
        expect((await exportLegacyJsonBackup()).version).toBe(2);
    });

    it('错题与举一反三记录的全部字段完整保留（兼容 JSON v2 含 AiProvenance 溯源关联）', async () => {
        const backup = await exportLegacyJsonBackup();
        expect(backup.aiProvenances).toHaveLength(1);
        await clearUserData();
        const { stats, warnings } = await importBackup(backup);
        expect(stats).toMatchObject({ errorItemsCreated: 1, practiceRecordsCreated: 1, reviewSchedulesCreated: 1, tagsLinked: 1 });
        expect(warnings).toContain('LEGACY_JSON_PARTIAL_FORMAT');

        const item = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' }, include: { tags: true, subject: true } });
        expect(item.provenanceId).toBeTruthy();
        const prov = await database.aiProvenance.findUniqueOrThrow({ where: { id: item.provenanceId! } });
        expect(prov).toMatchObject({ task: 'analyze', provider: 'gemini', model: 'gemini-2.5-flash', promptVersion: 'abc123def456', parserVersion: 'v2-latex-sm' });
        expect(item).toMatchObject({
            shortId: 'AbC234', questionText: '求解 x + 2 = 5', difficultyStars: 3, hasFigure: true, figureSvg: figure,
            geogebraCommands: 'A=(0,0)\nB=(1,1)', svgAnimation: animation('中文'), svgAnimationEn: animation('English'), lastPractice,
            masteryProbability: 0.8, masteryReason: '连续答对', masterySource: 'ai', masteryEvaluatedAt: new Date('2026-10-21T00:00:00Z'),
            createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-21T00:00:00Z'),
        });
        expect(item.subject).toMatchObject({ name: '数学', stage: 'junior_high', subjectKey: 'math' });
        expect(item.tags.map((tag) => tag.name)).toEqual(['自定义标签']);

        const record = await database.practiceRecord.findFirstOrThrow({ where: { errorItemId: item.id } });
        expect(record).toMatchObject({ result: 'correct', questionText: '变式题', figureSvg: figure, source: 'practice' });
        // 已带掌握概率导入，不重复评估
        expect(mocks.scheduleMasteryEvaluation).not.toHaveBeenCalled();
    });

    it('没有掌握概率的题目导入后重新评估', async () => {
        await database.errorItem.update({ where: { id: 'item-1' }, data: { masteryProbability: null, masteryEvaluatedAt: null } });
        const backup = await exportLegacyJsonBackup();
        await clearUserData();
        await importBackup(backup);
        const item = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } });
        expect(item.masteryProbability).toBeNull();
        expect(mocks.scheduleMasteryEvaluation).toHaveBeenCalledWith([item.id]);
    });

    it('试卷、试卷题目及其作答记录完整保留，重复导入不新建试卷', async () => {
        await database.examPaper.create({
            data: {
                id: 'paper-1', userId: 'user-1', title: '周测', status: 'generating', scope: 'unmastered', difficulty: 'hard', requestedCount: 2,
                subjectIds: JSON.stringify(['math']), tagNames: JSON.stringify(['自定义标签']), resultsRecordedAt: new Date('2026-10-22T00:00:00Z'),
                createdAt: new Date('2026-10-21T00:00:00Z'),
                questions: { create: [
                    { id: 'question-1', order: 0, errorItemId: 'item-1', sourceShortId: 'AbC234', status: 'ready', questionText: '试卷新题', answerText: '答', analysis: '析', figureSvg: figure },
                    { id: 'question-2', order: 1, errorItemId: 'item-1', sourceShortId: 'AbC234', status: 'pending' },
                ] },
            },
        });
        await database.practiceRecord.create({
            data: { userId: 'user-1', errorItemId: 'item-1', examQuestionId: 'question-1', result: 'wrong', isCorrect: false, source: 'exam', questionText: '试卷新题' },
        });
        const backup = await exportLegacyJsonBackup();
        await clearUserData();
        const { stats } = await importBackup(backup);
        expect(stats.examPapersCreated).toBe(1);

        const item = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } });
        const subject = await database.subject.findFirstOrThrow({ where: { userId: 'user-1' } });
        const paper = await database.examPaper.findFirstOrThrow({ where: { userId: 'user-1' }, include: { questions: { orderBy: { order: 'asc' } } } });
        expect(paper).toMatchObject({
            title: '周测', status: 'partial', scope: 'unmastered', difficulty: 'hard', requestedCount: 2,
            subjectIds: JSON.stringify([subject.id]), tagNames: JSON.stringify(['自定义标签']),
            resultsRecordedAt: new Date('2026-10-22T00:00:00Z'), createdAt: new Date('2026-10-21T00:00:00Z'),
        });
        expect(paper.questions).toMatchObject([
            { order: 0, errorItemId: item.id, sourceShortId: 'AbC234', status: 'ready', questionText: '试卷新题', figureSvg: figure },
            // 导出时仍在生成的题目按失败导入
            { order: 1, errorItemId: item.id, status: 'failed' },
        ]);
        expect(await database.practiceRecord.findFirstOrThrow({ where: { source: 'exam' } })).toMatchObject({ examQuestionId: paper.questions[0].id, errorItemId: item.id });

        // 再导入一次：试卷不重复，作答记录关联到已有的试卷题目
        const again = await importBackup(backup);
        expect(again.stats.examPapersCreated).toBe(0);
        expect(await database.examPaper.count({ where: { userId: 'user-1' } })).toBe(1);
        const examRecords = await database.practiceRecord.findMany({ where: { source: 'exam' } });
        expect(examRecords.map((record) => record.examQuestionId)).toEqual([paper.questions[0].id, paper.questions[0].id]);
    });

    it('云端语音随备份导入、导出：只导出与动画讲解一致的语音，不合法的跳过，已有的不重复写入', async () => {
        const narrated = embedNarration(animation('画面'), [{ begin: 0, text: '先看条件' }]);
        await database.errorItem.update({ where: { id: 'item-1' }, data: { svgAnimation: narrated } });
        const audio = encodeMp3({ sampleRate: 24000, samples: new Float32Array(2400) }).toString('base64');
        const speech = { provider: 'minimax', model: 'speech-2.8-hd', voice: 'male-qn-jingying', language: 'zh', text: '先看条件', audio };

        const backup = await exportLegacyJsonBackup();
        expect(backup.ttsSpeeches).toEqual([]);

        const { stats } = await importBackup({
            ...backup,
            ttsSpeeches: [
                speech,
                { ...speech, text: '与动画无关的话' },
                { ...speech, text: '不是 MP3', audio: Buffer.from('not mp3').toString('base64') },
                { ...speech, provider: 'unknown' },
                { ...speech, text: '' },
            ],
        });
        expect(stats.ttsSpeechesImported).toBe(2);

        const exported = await exportLegacyJsonBackup();
        expect(exported.ttsSpeeches).toEqual([speech]);
        expect((await importBackup(exported)).stats.ttsSpeechesImported).toBe(0);
    });

    it('还原本人的偏好设置，不合法的单项跳过', async () => {
        await database.user.update({
            where: { id: 'user-1' },
            data: { confirmBeforeImport: true, questionDuplicateThreshold: 75.5, masteryThreshold: 70, enableGeogebra: true, enableSvgAnimation: false, themePreference: 'dark', gradeRecognitionMode: 'ai', fixedGradeSemester: '四年级上', variantPipelineEnabled: false },
        });
        const backup = await exportLegacyJsonBackup();
        expect(backup.user).toMatchObject({ confirmBeforeImport: true, questionDuplicateThreshold: 75.5, masteryThreshold: 70, enableGeogebra: true, enableSvgAnimation: false, themePreference: 'dark', gradeRecognitionMode: 'ai', fixedGradeSemester: '四年级上', variantPipelineEnabled: false });

        await database.user.update({
            where: { id: 'user-1' },
            data: { confirmBeforeImport: false, questionDuplicateThreshold: 90, masteryThreshold: 50, enableGeogebra: false, enableSvgAnimation: true, themePreference: 'system', gradeRecognitionMode: 'fixed', fixedGradeSemester: null, variantPipelineEnabled: true },
        });
        backup.user.questionDuplicateThreshold = 500;
        const { stats } = await importBackup(backup);
        expect(stats.preferencesRestored).toBe(true);
        expect(await database.user.findUniqueOrThrow({ where: { id: 'user-1' } })).toMatchObject({
            confirmBeforeImport: true, questionDuplicateThreshold: 90, masteryThreshold: 70, enableGeogebra: true, enableSvgAnimation: false, themePreference: 'dark',
            gradeRecognitionMode: 'ai', fixedGradeSemester: '四年级上', variantPipelineEnabled: false,
        });
    });

    it('旧版文件没有偏好设置时不改动当前设置', async () => {
        await database.user.update({ where: { id: 'user-1' }, data: { enableGeogebra: true, gradeRecognitionMode: 'ai', fixedGradeSemester: '四年级下' } });
        const { stats } = await importBackup({ version: 1, user: { email: mocks.session.user.email }, errorItems: [] });
        expect(stats.preferencesRestored).toBe(false);
        expect((await database.user.findUniqueOrThrow({ where: { id: 'user-1' } })).enableGeogebra).toBe(true);
        expect(await database.user.findUniqueOrThrow({ where: { id: 'user-1' } })).toMatchObject({ gradeRecognitionMode: 'ai', fixedGradeSemester: '四年级下' });
    });

    it('无效年级规则不覆盖当前偏好，恢复题目保留原有年级', async () => {
        const backup = await exportLegacyJsonBackup();
        backup.user.gradeRecognitionMode = 'invalid';
        backup.user.fixedGradeSemester = '十三年级上';
        await database.user.update({ where: { id: 'user-1' }, data: { gradeRecognitionMode: 'fixed', fixedGradeSemester: '四年级下' } });
        await clearUserData();
        await importBackup(backup);
        expect(await database.user.findUniqueOrThrow({ where: { id: 'user-1' } })).toMatchObject({ gradeRecognitionMode: 'fixed', fixedGradeSemester: '四年级下' });
        expect((await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } })).gradeSemester).toBe('初二上');
    });

    it('导入时重新净化 SVG，丢弃不合法的暂存练习和掌握概率', async () => {
        const backup = await exportLegacyJsonBackup();
        await clearUserData();
        Object.assign(backup.errorItems[0], {
            svgAnimation: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>',
            svgAnimationEn: 'not svg',
            lastPractice: '{"questionText":""}',
            masteryProbability: 3,
        });
        await importBackup(backup);
        const item = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } });
        expect(item.svgAnimation).not.toContain('script');
        expect(item.svgAnimationEn).toBeNull();
        expect(item.lastPractice).toBeNull();
        expect(item.masteryProbability).toBeNull();
        expect(mocks.scheduleMasteryEvaluation).toHaveBeenCalledWith([item.id]);
    });

    it('导出并还原变式审核记录，清空数据时删除原记录', async () => {
        await database.variantRun.create({
            data: {
                id: 'run-1', userId: 'user-1', kind: 'practice', mode: 'pipeline', status: 'completed',
                language: 'zh', title: '方程变式', errorItemId: 'item-1',
                items: { create: {
                    id: 'vitem-1', index: 0, status: 'pending_review',
                    questionText: '解方程 3x=9', answerText: '3', analysis: '两边除以 3',
                    knowledgePoints: '["方程"]', plannedDifficulty: 'medium',
                } },
            },
        });
        const backup = await exportLegacyJsonBackup();
        expect(backup.variantRuns).toHaveLength(1);
        expect(backup.variantRuns[0]).toMatchObject({ title: '方程变式', kind: 'practice' });
        expect(backup.variantRuns[0].items[0].questionText).toBe('解方程 3x=9');

        await clearUserData();
        expect(await database.variantRun.count({ where: { userId: 'user-1' } })).toBe(0);

        const { stats } = await importBackup(backup);
        expect(stats.variantRunsCreated).toBe(1);
        const imported = await database.variantRun.findFirstOrThrow({ where: { userId: 'user-1' }, include: { items: true } });
        expect(imported).toMatchObject({ title: '方程变式', kind: 'practice', mode: 'pipeline' });
        expect(imported.items[0]).toMatchObject({ questionText: '解方程 3x=9', status: 'pending_review' });
        const remappedItem = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } });
        expect(imported.errorItemId).toBe(remappedItem.id);
    });
});

describe('流式 ZIP 备份 v3 完整迁移与验证', () => {
    it('完整往返：孩子档案/家长试卷/教师批改/变式阶段/掌握度与学习路径/图片去重 SHA-256 全部一致，并处理遗留 ReviewSchedule', async () => {
        const imgA = Buffer.from('fake-png-bytes-alpha-1234567890');
        const imgB = Buffer.from('fake-png-bytes-beta-abcdefghij');
        const urlA = `data:image/png;base64,${imgA.toString('base64')}`;
        const urlB = `data:image/jpeg;base64,${imgB.toString('base64')}`;
        const hashA = crypto.createHash('sha256').update(imgA).digest('hex');
        const hashB = crypto.createHash('sha256').update(imgB).digest('hex');

        // 构造完整多人学习数据
        const childActive = await database.learner.create({
            data: { id: 'child-active', userId: 'user-1', kind: 'child', name: '小明', order: 0 },
        });
        const childArchived = await database.learner.create({
            data: { id: 'child-arch', userId: 'user-1', kind: 'child', name: '归档孩子', order: 1, archivedAt: new Date('2026-10-01T00:00:00Z') },
        });
        await database.errorItem.update({
            where: { id: 'item-1' },
            data: { learnerId: childActive.id, originalImageUrl: urlA },
        });
        await database.errorItem.create({
            data: {
                id: 'item-2', shortId: 'Ch2001', userId: 'user-1', subjectId: 'math',
                learnerId: childArchived.id, originalImageUrl: urlA, questionText: '已归档孩子错题',
            },
        });
        await database.practiceRecord.updateMany({
            where: { errorItemId: 'item-1' },
            data: { learnerId: childActive.id, originalImageUrl: urlB },
        });

        const cls = await database.gradingClass.create({
            data: { id: 'cls-v3', userId: 'user-1', name: '初二1班' },
        });
        const stu = await database.gradingStudent.create({
            data: { id: 'stu-v3', classId: cls.id, name: '李华', studentNo: '09', order: 0 },
        });
        await database.learner.create({
            data: { id: 'ln-stu-v3', userId: 'user-1', kind: 'student', name: '李华', gradingStudentId: stu.id },
        });
        const pp = await database.parentPaper.create({
            data: {
                id: 'pp-v3', userId: 'user-1', learnerId: childActive.id, title: '单元卷',
                status: 'confirmed', hasAnswerKey: true, answerKeyImages: JSON.stringify([urlB]),
                pages: { create: { id: 'ppp-v3', position: 0, imageUrl: urlA, originalImageUrl: urlB } },
                questions: { create: {
                    id: 'ppq-v3', position: 0, number: '1', verdict: 'wrong',
                    questionText: '求解 x+2=5', importedErrorItemId: 'item-1', provenanceId: 'prov-1',
                } },
            },
        });
        expect(pp.id).toBe('pp-v3');
        const task = await database.gradingTask.create({
            data: {
                id: 'gt-v3', userId: 'user-1', classId: cls.id, title: '月考', subjectName: '数学', keyImageUrl: urlB,
                allowSelfSubmit: true,
                questions: { create: { id: 'gkq-v3', order: 0, number: '1', answer: '3' } },
            },
        });
        await database.dailyHomeworkItem.createMany({
            data: [
                { userId: 'user-1', learnerId: childActive.id, dateKey: '2026-11-18', subjectKey: 'math', category: 'written', title: '练习册P1' },
                { userId: 'user-1', learnerId: childActive.id, dateKey: '2026-11-18', subjectKey: 'english', category: 'written', title: '练习册P1' },
            ],
        });
        const sub = await database.gradingSubmission.create({
            data: {
                id: 'gs-v3', taskId: task.id, studentId: stu.id, status: 'confirmed',
                images: JSON.stringify([urlA]),
                matchCandidates: JSON.stringify([{ studentId: stu.id, confidence: 0.99 }]),
                results: { create: { id: 'gr-v3', keyQuestionId: 'gkq-v3', verdict: 'wrong', errorItemId: 'item-1', provenanceId: 'prov-1' } },
            },
        });
        expect(sub.id).toBe('gs-v3');

        const run = await database.variantRun.create({
            data: {
                id: 'vr-v3', userId: 'user-1', kind: 'practice', mode: 'pipeline', status: 'completed',
                title: 'v3变式', errorItemId: 'item-1', classId: cls.id, studentId: stu.id, subjectId: 'math',
            },
        });
        const vi = await database.variantItem.create({
            data: {
                id: 'vi-v3', runId: run.id, index: 0, status: 'approved', questionText: '新变式题',
                answerText: '5', knowledgePoints: '["方程"]', sourceItemId: 'item-1', provenanceId: 'prov-1',
            },
        });
        await database.variantStageLog.create({
            data: { id: 'vs-v3', runId: run.id, itemId: vi.id, stage: 'verify', status: 'ok', latencyMs: 120 },
        });
        await database.knowledgeMastery.create({
            data: { userId: 'user-1', studentKey: childActive.id, knowledgePoint: '方程', pKnown: 0.65, evidenceCount: 3 },
        });
        await database.knowledgeMastery.create({
            data: { userId: 'user-1', studentKey: stu.id, knowledgePoint: '方程', pKnown: 0.4, evidenceCount: 1 },
        });
        await database.user.update({ where: { id: 'user-1' }, data: { reviewAlgorithmVersion: 'fsrs-v1' } });
        await database.itemMemory.create({
            data: {
                userId: 'user-1',
                learnerId: childActive.id,
                scopeKey: childActive.id,
                errorItemId: 'item-1',
                stability: 4.5,
                difficulty: 4.2,
                lastReviewAt: new Date('2026-10-20T08:00:00.000Z'),
                dueAt: new Date('2026-10-24T16:00:00.000Z'),
                reps: 2,
                lapses: 0,
                algorithmVersion: 'fsrs-v1',
            },
        });
        await database.learningPath.create({
            data: {
                userId: 'user-1', studentKey: childActive.id, studentName: '小明', evidenceHash: 'eh1',
                steps: { create: {
                    position: 0, type: 'variant_practice', title: '巩固', reason: '高频错题',
                    knowledgePoints: '["方程"]', errorItemIds: JSON.stringify(['item-1']),
                    variantRunId: run.id, teacherNote: '周末重练', href: '/practice?itemId=item-1',
                } },
            },
        });

        // 导出 v3 ZIP 并核查结构与去重图片 SHA-256
        const zipBytes = await exportZipBackup();
        const unpacked = unzipSync(zipBytes);
        const manifest = JSON.parse(Buffer.from(unpacked['manifest.json']).toString('utf8')) as BackupManifestV3;
        expect(manifest.formatVersion).toBe(3);
        expect(manifest.counts).toMatchObject({
            learners: 3, errorItems: 2, parentPapers: 1, gradingTasks: 1, variantRuns: 1, variantStageLogs: 1,
        });
        expect(manifest.derivedCounts).toMatchObject({ knowledgeMasteries: 2, itemMemories: 1, learningPaths: 1, learningPathSteps: 1 });
        expect(manifest.files[`media/${hashA}`]).toBeDefined();
        expect(manifest.files[`media/${hashB}`]).toBeDefined();
        expect(crypto.createHash('sha256').update(unpacked[`media/${hashA}`]).digest('hex')).toBe(hashA);
        expect(crypto.createHash('sha256').update(unpacked[`media/${hashB}`]).digest('hex')).toBe(hashB);

        // 清空除 User 外的全部业务数据并重置偏好，再导入 ZIP
        await clearUserData();
        await database.user.update({ where: { id: 'user-1' }, data: { reviewAlgorithmVersion: 'ebbinghaus-v1' } });
        const { response, data } = await importZipBackup(zipBytes);
        expect(response.status).toBe(200);
        expect(data.warnings).toContain('LEGACY_REVIEW_SCHEDULE_IGNORED');
        expect(data.stats).toMatchObject({
            learnersCreated: 3, errorItemsCreated: 2, reviewSchedulesCreated: 0,
            parentPapersCreated: 1, gradingTasksCreated: 1, variantRunsCreated: 1,
            knowledgeMasteriesImported: 2, itemMemoriesImported: 1, learningPathsCreated: 1,
        });

        // 遗留 ReviewSchedule 在 v3 导入中被忽略，不写回已弃用表
        expect(await database.reviewSchedule.count()).toBe(0);

        const restoredActive = await database.learner.findFirstOrThrow({ where: { userId: 'user-1', kind: 'child', archivedAt: null } });
        const restoredArchived = await database.learner.findFirstOrThrow({ where: { userId: 'user-1', kind: 'child', archivedAt: { not: null } } });
        expect(restoredArchived.name).toBe('归档孩子');

        const activeItems = await database.errorItem.findMany({ where: { learnerId: restoredActive.id } });
        const archivedItems = await database.errorItem.findMany({ where: { learnerId: restoredArchived.id } });
        expect(activeItems).toHaveLength(1);
        expect(archivedItems).toHaveLength(1);
        expect(activeItems[0].originalImageUrl).toBe(urlA);

        const restoredStages = await database.variantStageLog.findMany();
        expect(restoredStages).toHaveLength(1);
        expect(restoredStages[0]).toMatchObject({ stage: 'verify', status: 'ok', latencyMs: 120 });

        const restoredPaperPage = await database.parentPaperPage.findFirstOrThrow();
        expect(restoredPaperPage.imageUrl).toBe(urlA);
        expect(restoredPaperPage.originalImageUrl).toBe(urlB);

        const restoredPath = await database.learningPath.findFirstOrThrow({ include: { steps: true } });
        expect(restoredPath.studentKey).toBe(restoredActive.id);
        expect(restoredPath.steps[0].teacherNote).toBe('周末重练');
        expect(restoredPath.steps[0].href).toBe(`/practice?itemId=${activeItems[0].id}`);
        expect(JSON.parse(restoredPath.steps[0].errorItemIds!)).toEqual([activeItems[0].id]);

        const restoredUser = await database.user.findUniqueOrThrow({ where: { id: 'user-1' } });
        expect(restoredUser.reviewAlgorithmVersion).toBe('fsrs-v1');
        const restoredMemory = await database.itemMemory.findFirstOrThrow();
        expect(restoredMemory).toMatchObject({
            learnerId: restoredActive.id,
            scopeKey: restoredActive.id,
            errorItemId: activeItems[0].id,
            stability: 4.5,
            difficulty: 4.2,
            reps: 2,
            lapses: 0,
            algorithmVersion: 'fsrs-v1',
        });

        // 剥离 token 后 allowSelfSubmit 自动复位为 false，且不同学科同名日常作业不误去重
        const restoredTask = await database.gradingTask.findFirstOrThrow({ where: { title: '月考' } });
        expect(restoredTask.allowSelfSubmit).toBe(false);
        const restoredHomeworks = await database.dailyHomeworkItem.findMany({ where: { userId: 'user-1' } });
        expect(restoredHomeworks.map((h) => h.subjectKey).sort()).toEqual(['english', 'math']);
    });

    it('exportAll / importAll 多用户恢复时，VariantRun.userId 正确映射回各自用户而非硬编码管理员（R05）', async () => {
        await database.user.update({ where: { id: 'user-1' }, data: { role: 'admin' } });
        const bob = await database.user.create({
            data: { id: 'bob-1', email: 'bob-backup@example.com', password: 'x', role: 'user' },
        });
        await database.variantRun.create({
            data: { id: 'vr-bob', userId: bob.id, kind: 'topic', mode: 'pipeline', status: 'completed', title: 'Bob专属专题' },
        });

        mocks.session = { user: { id: 'user-1', email: 'backup-test@example.com', role: 'admin' }, expires: '2099-01-01' };
        const zipBytes = await exportZipBackup('?all=true');
        const jsonResponse = await EXPORT(new Request('http://localhost/api/export?all=true&format=json'));
        const json = await jsonResponse.json();
        await clearUserData();
        const zipForPersonal = await importZipBackup(zipBytes);
        expect(zipForPersonal.response.status).toBe(400);
        expect(zipForPersonal.data.code).toBe('BACKUP_ALL_USERS_REQUIRED');
        const jsonForPersonal = await IMPORT(new Request('http://localhost/api/import', {
            method: 'POST', body: JSON.stringify(json),
        }));
        expect(jsonForPersonal.status).toBe(400);
        expect((await jsonForPersonal.json()).code).toBe('BACKUP_ALL_USERS_REQUIRED');
        expect(await database.errorItem.count()).toBe(0);
        expect(await database.variantRun.count()).toBe(0);
        // 删除重建 Bob（模拟新库不同 ID 但同邮箱的场景）
        await database.user.delete({ where: { id: bob.id } });
        const newBob = await database.user.create({
            data: { id: 'bob-recreated', email: 'bob-backup@example.com', password: 'x', role: 'user' },
        });

        const { response, data } = await importZipBackup(zipBytes, '?all=true');
        expect(response.status).toBe(200);
        expect(data.stats.variantRunsCreated).toBe(1);
        const restoredRun = await database.variantRun.findFirstOrThrow({ where: { title: 'Bob专属专题' } });
        expect(restoredRun.userId).toBe(newBob.id);
    });

    it('同名孩子和无学号的同名学生分别恢复，重复导入仍使用同一档案', async () => {
        const userId = 'user-1';
        await database.gradingClass.create({ data: { id: 'class', name: '一班', userId } });
        for (const key of ['a', 'b']) {
            await database.learner.create({ data: { id: `child-${key}`, userId, kind: 'child', name: '同名孩子' } });
            await database.gradingStudent.create({ data: { id: `student-${key}`, classId: 'class', name: '同名学生' } });
            await database.learner.create({ data: {
                userId, kind: 'student', name: '同名学生', gradingStudentId: `student-${key}`,
            } });
            await database.dailyHomeworkItem.create({ data: {
                userId, learnerId: `child-${key}`, title: key, dateKey: '2026-11-19',
            } });
        }
        const zip = await exportZipBackup();
        await clearUserData();
        for (let i = 0; i < 2; i++) {
            expect((await importZipBackup(zip)).response.status).toBe(200);
            const children = await database.learner.findMany({
                where: { kind: 'child' }, orderBy: { id: 'asc' },
                select: { id: true, dailyHomeworks: { select: { title: true } } },
            });
            expect(children).toEqual([
                { id: 'child-a', dailyHomeworks: [{ title: 'a' }] },
                { id: 'child-b', dailyHomeworks: [{ title: 'b' }] },
            ]);
            const students = await database.learner.findMany({
                where: { kind: 'student' }, orderBy: { gradingStudentId: 'asc' },
                select: { gradingStudentId: true },
            });
            expect(students.map((row) => row.gradingStudentId)).toEqual(['student-a', 'student-b']);
        }
        // 新环境先手动建了同名孩子：第一个同名档案并入它，另一个按备份 ID 新建，不再整包回滚
        await clearUserData();
        const manual = await database.learner.create({ data: { userId, kind: 'child', name: '同名孩子' } });
        const merged = await importZipBackup(zip);
        expect(merged.response.status).toBe(200);
        const children = await database.learner.findMany({
            where: { kind: 'child' }, orderBy: { createdAt: 'asc' },
            select: { id: true, dailyHomeworks: { select: { title: true } } },
        });
        expect(children).toHaveLength(2);
        expect(children.find((child) => child.id === manual.id)?.dailyHomeworks.length).toBe(1);
        expect(children.flatMap((child) => child.dailyHomeworks.map((hw) => hw.title)).sort()).toEqual(['a', 'b']);
        expect(await database.gradingStudent.count()).toBe(2);
    });

    it('表单上传超过上限时在读完请求体之前返回 413 BACKUP_TOO_LARGE', async () => {
        const previous = process.env.BACKUP_MAX_UPLOAD_BYTES;
        process.env.BACKUP_MAX_UPLOAD_BYTES = '4096';
        try {
            const zip = await exportZipBackup();
            await clearUserData();
            const limit = 4096 + 1024 * 1024;
            const boundary = 'xueji-limit-test';
            const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`);

            // 1) 声明的 Content-Length 超限：直接拒绝，请求体一个字节都不读
            let pulled = 0;
            const untouched = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(head); } });
            const declared = await IMPORT(new Request('http://localhost/api/import', {
                method: 'POST',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(limit + 1) },
                body: untouched,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' }));
            expect(declared.status).toBe(413);
            expect((await declared.json()).code).toBe('BACKUP_TOO_LARGE');
            expect(pulled).toBeLessThanOrEqual(1);

            // 2) 没有 Content-Length 的分块上传：边读边计数，超限即中断
            const chunk = new Uint8Array(256 * 1024);
            let sent = 0;
            const chunked = new ReadableStream<Uint8Array>({
                start(controller) { controller.enqueue(head); },
                pull(controller) {
                    sent += chunk.byteLength;
                    if (sent > limit * 4) { controller.close(); return; }
                    controller.enqueue(chunk);
                },
            });
            const streamed = await IMPORT(new Request('http://localhost/api/import', {
                method: 'POST',
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
                body: chunked,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' }));
            expect(streamed.status).toBe(413);
            expect((await streamed.json()).code).toBe('BACKUP_TOO_LARGE');
            expect(sent).toBeLessThan(limit * 2);
            expect(await database.errorItem.count()).toBe(0);

            // 3) 上限以内的正常表单上传不受影响（4 KiB 上限下备份本身超限，单独放宽到 64 MiB 验证）
            process.env.BACKUP_MAX_UPLOAD_BYTES = String(64 * 1024 * 1024);
            expect((await importZipBackup(zip)).response.status).toBe(200);
        } finally {
            if (previous === undefined) delete process.env.BACKUP_MAX_UPLOAD_BYTES;
            else process.env.BACKUP_MAX_UPLOAD_BYTES = previous;
        }
    });

    it('新环境先建了孩子「小雨」和同名无学号学生后再恢复旧备份，合并到已有档案', async () => {
        const userId = 'user-1';
        await database.learner.create({ data: { id: 'old-xiaoyu', userId, kind: 'child', name: '小雨' } });
        await database.dailyHomeworkItem.create({ data: { userId, learnerId: 'old-xiaoyu', title: '旧作业', dateKey: '2026-11-18' } });
        await database.gradingClass.create({ data: { id: 'old-class', name: '三班', userId } });
        await database.gradingStudent.create({ data: { id: 'old-stu', classId: 'old-class', name: '小明' } });
        const zip = await exportZipBackup();
        await clearUserData();

        const newChild = await database.learner.create({ data: { userId, kind: 'child', name: '小雨' } });
        const newClass = await database.gradingClass.create({ data: { name: '三班', userId } });
        const newStudent = await database.gradingStudent.create({ data: { classId: newClass.id, name: '小明' } });
        const { response, data } = await importZipBackup(zip);
        expect(response.status).toBe(200);
        expect(data.code).toBeUndefined();
        const children = await database.learner.findMany({ where: { userId, kind: 'child' } });
        expect(children.map((child) => child.id)).toEqual([newChild.id]);
        const homework = await database.dailyHomeworkItem.findFirstOrThrow({ where: { title: '旧作业' } });
        expect(homework.learnerId).toBe(newChild.id);
        expect((await database.gradingStudent.findMany()).map((stu) => stu.id)).toEqual([newStudent.id]);
    });

    it('同一老师名下学生已转到其他班时并入原学生，不再 409', async () => {
        const userId = 'user-1';
        await database.gradingClass.create({ data: { id: 'class-a', name: '一班', userId } });
        await database.gradingClass.create({ data: { id: 'class-b', name: '二班', userId } });
        await database.gradingStudent.create({ data: { id: 'moving-stu', classId: 'class-a', name: '转班生', studentNo: '07' } });
        const zip = await exportZipBackup();
        await database.gradingStudent.update({ where: { id: 'moving-stu' }, data: { classId: 'class-b' } });
        const { response } = await importZipBackup(zip);
        expect(response.status).toBe(200);
        const students = await database.gradingStudent.findMany({ where: { name: '转班生' } });
        expect(students.map((stu) => [stu.id, stu.classId])).toEqual([['moving-stu', 'class-b']]);
    });

    it('同 ID 的孩子与学生属于其他账号时新建自己的档案，绝不跨账号映射', async () => {
        const userId = 'user-1';
        await database.learner.create({ data: { id: 'shared-child', userId, kind: 'child', name: '小雨' } });
        await database.dailyHomeworkItem.create({ data: { userId, learnerId: 'shared-child', title: '我的作业', dateKey: '2026-11-18' } });
        await database.gradingClass.create({ data: { id: 'my-class', name: '一班', userId } });
        await database.gradingStudent.create({ data: { id: 'shared-stu', classId: 'my-class', name: '小明', studentNo: '01' } });
        const zip = await exportZipBackup();
        await clearUserData();

        const other = await database.user.create({ data: { id: 'other-owner', email: 'other-owner@example.com', password: 'x' } });
        await database.learner.create({ data: { id: 'shared-child', userId: other.id, kind: 'child', name: '小雨' } });
        await database.gradingClass.create({ data: { id: 'other-class', name: '一班', userId: other.id } });
        await database.gradingStudent.create({ data: { id: 'shared-stu', classId: 'other-class', name: '小明', studentNo: '01' } });

        const { response } = await importZipBackup(zip);
        expect(response.status).toBe(200);
        const mine = await database.learner.findFirstOrThrow({ where: { userId, kind: 'child' } });
        expect(mine.id).not.toBe('shared-child');
        expect((await database.dailyHomeworkItem.findFirstOrThrow({ where: { title: '我的作业' } })).learnerId).toBe(mine.id);
        const theirs = await database.learner.findUniqueOrThrow({ where: { id: 'shared-child' } });
        expect(theirs.userId).toBe(other.id);
        expect(await database.dailyHomeworkItem.count({ where: { learnerId: 'shared-child' } })).toBe(0);
        const myStudent = await database.gradingStudent.findFirstOrThrow({ where: { class: { userId } } });
        expect(myStudent.id).not.toBe('shared-stu');
        expect((await database.gradingStudent.findUniqueOrThrow({ where: { id: 'shared-stu' } })).classId).toBe('other-class');

        await database.learner.deleteMany({ where: { userId: other.id } });
        await database.gradingStudent.deleteMany({ where: { classId: 'other-class' } });
        await database.gradingClass.deleteMany({ where: { userId: other.id } });
        await database.user.delete({ where: { id: other.id } });
    });

    it('旧 JSON 中仅有名称的标签在目标库中唯一时能恢复，同名冲突时整次回滚', async () => {
        const json = await exportLegacyJsonBackup();
        json.customTags = [];
        json.errorItems[0].tags = [{ name: '旧标签' }];
        await clearUserData();
        await database.knowledgeTag.createMany({ data: [
            { name: '旧标签', subject: 'math', isSystem: true },
            { name: '旧标签', subject: 'english', isSystem: true },
        ] });
        const conflict = await IMPORT(new Request('http://localhost/api/import', {
            method: 'POST', body: JSON.stringify(json),
        }));
        expect(conflict.status).toBe(409);
        expect((await conflict.json()).code).toBe('BACKUP_TAG_AMBIGUOUS');
        expect(await database.subject.count()).toBe(0);
        await database.knowledgeTag.deleteMany({ where: { subject: 'english' } });
        expect((await importBackup(json)).stats.tagsLinked).toBe(1);
        const item = await database.errorItem.findFirstOrThrow({ include: { tags: true } });
        expect(item.tags.map((tag) => tag.name)).toEqual(['旧标签']);
    });

    it.each(['zip', 'json'])('%s 往返保留跨学科与同科不同教材层级的同名标签', async (format) => {
        async function addCurriculum(prefix: string) {
            for (const book of ['上册', '下册']) {
                const root = await database.knowledgeTag.create({ data: {
                    id: prefix + book, name: book, subject: 'math', isSystem: true,
                } });
                await database.knowledgeTag.create({ data: {
                    id: prefix + book + '-system', name: '系统知识点', subject: 'math', isSystem: true, parentId: root.id,
                } });
            }
        }
        await addCurriculum('old');
        for (const [id, subject, parentId] of [
            ['top', 'math', 'old上册'], ['bottom', 'math', 'old下册'], ['english', 'english', null],
        ] as const) {
            const tag = await database.knowledgeTag.create({ data: {
                id, name: '同名标签', subject, userId: 'user-1', parentId,
            } });
            await database.errorItem.update({ where: { id: 'item-1' }, data: { tags: { connect: { id: tag.id } } } });
        }
        await database.errorItem.update({ where: { id: 'item-1' }, data: { tags: { connect: { id: 'old下册-system' } } } });
        const zip = format === 'zip' ? await exportZipBackup() : null;
        const json = zip ? null : await exportLegacyJsonBackup();
        await clearUserData();
        await addCurriculum('new');
        if (zip) expect((await importZipBackup(zip)).response.status).toBe(200);
        else expect((await importBackup(json)).stats.errorItemsCreated).toBe(1);
        const item = await database.errorItem.findFirstOrThrow({ include: { tags: { include: { parent: true } } } });
        expect(item.tags.filter((tag) => tag.name === '同名标签').map((tag) => [tag.subject, tag.parent?.name ?? null]).sort())
            .toEqual([['english', null], ['math', '上册'], ['math', '下册']].sort());
        expect(item.tags.find((tag) => tag.isSystem)?.id).toBe('new下册-system');
    });

    it('拒绝 manifest 文件摘要被篡改的损坏 ZIP，且数据库保持空', async () => {
        const zipBytes = await exportZipBackup();
        const unpacked = unzipSync(zipBytes);
        unpacked['data/errorItems.ndjson'] = Buffer.from(`${Buffer.from(unpacked['data/errorItems.ndjson']).toString('utf8')} `, 'utf8');
        const tampered = zipSync(unpacked);

        await clearUserData();
        const { response, data } = await importZipBackup(tampered);
        expect(response.status).toBe(400);
        expect(data.code).toBe('INVALID_BACKUP');
        expect(await database.errorItem.count()).toBe(0);
    });

    it('媒体包含 ZIP 元数据的字节序列时，整个条目可原样往返', async () => {
        // 1×1 GIF 的注释扩展支持任意字节；嵌入一份普通 ZIP 作为图片元数据。
        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
        const comment = zipSync({ 'note.txt': Buffer.from('offline media') }, { level: 0 });
        const media = Buffer.concat([
            gif.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b]),
        ]);
        const originalImageUrl = `data:image/gif;base64,${media.toString('base64')}`;
        await database.errorItem.update({ where: { id: 'item-1' }, data: { originalImageUrl } });
        const zip = await exportZipBackup();
        await clearUserData();
        const { response, data } = await importZipBackup(zip);
        expect(response.status, data.message).toBe(200);
        expect((await database.errorItem.findFirstOrThrow()).originalImageUrl).toBe(originalImageUrl);
    });

    it('大规模含图库流式导出与导入的 RSS 峰值增量远小于 150MB（验证游标分页与媒体流式落盘）', async () => {
        // 写入 16 道各自独立的高熵不可压缩 4MB 图片（合计 ~85MB base64 入库载荷），检测真实内存曲线
        const imagesCount = 16;
        const rawBytesEach = 4 * 1024 * 1024;
        for (let i = 0; i < imagesCount; i++) {
            const payload = crypto.randomBytes(rawBytesEach);
            const dataUrl = `data:image/png;base64,${payload.toString('base64')}`;
            const token = Array.from(
                crypto.createHash('sha256').update(`stream-bench-${i}`).digest('hex').slice(0, 24),
                (ch) => String.fromCharCode(65 + parseInt(ch, 16)),
            ).join('');
            await database.errorItem.create({
                data: {
                    shortId: `Mem0${String(i).padStart(2, '0')}`,
                    userId: 'user-1',
                    subjectId: 'math',
                    originalImageUrl: dataUrl,
                    questionText: `BenchMark-${token}`,
                },
            });
        }

        const baseRss = process.memoryUsage().rss;
        let peakDelta = 0;
        const trackRss = () => {
            const delta = process.memoryUsage().rss - baseRss;
            if (delta > peakDelta) peakDelta = delta;
        };

        // 边流式读取导出流边落盘，避免测试本身在 JS 中拼接大 ArrayBuffer 干扰真实流式测量
        const exportRes = await EXPORT(new Request('http://localhost/api/export'));
        expect(exportRes.status).toBe(200);
        const tmpZip = join(directory, 'large-bench.zip');
        const fsPromises = await import('node:fs/promises');
        const fh = await fsPromises.open(tmpZip, 'w');
        try {
            const reader = exportRes.body!.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                await fh.write(value);
                trackRss();
            }
        } finally {
            await fh.close();
        }

        await clearUserData();

        const fs = await import('node:fs');
        const { Readable } = await import('node:stream');
        const webStream = Readable.toWeb(fs.createReadStream(tmpZip)) as ReadableStream<Uint8Array>;
        const importRes = await IMPORT(new Request('http://localhost/api/import', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: webStream,
            duplex: 'half',
        } as RequestInit));
        trackRss();
        expect(importRes.status, importRes.ok ? undefined : await importRes.text()).toBe(200);
        expect(await database.errorItem.count({ where: { userId: 'user-1' } })).toBe(imagesCount + 1);
        expect(peakDelta).toBeLessThan(150 * 1024 * 1024);
    }, 60000);

    it('可选口令加密往返：未加密导出带告警头；加密后缺口令或错口令拒收，正确口令完整还原', async () => {
        const secret = 'MySecretPass!2026';
        await database.errorItem.create({
            data: {
                id: 'enc-item-1',
                shortId: 'Enc001',
                userId: 'user-1',
                subjectId: 'math',
                originalImageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                questionText: '隐私加密测试题干_SecretMarker',
                answerText: '42',
            },
        });

        // 1. 未设口令导出带 X-Backup-Unencrypted-Warning: 1
        const plainRes = await EXPORT(new Request('http://localhost/api/export'));
        expect(plainRes.status).toBe(200);
        expect(plainRes.headers.get('x-backup-unencrypted-warning')).toBe('1');
        expect(plainRes.headers.get('x-backup-encrypted')).toBe('0');

        // 2. 带口令 POST /api/export 导出加密 ZIP
        const encRes = await EXPORT_POST(new Request('http://localhost/api/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passphrase: secret }),
        }));
        expect(encRes.status).toBe(200);
        expect(encRes.headers.get('x-backup-encrypted')).toBe('1');
        expect(encRes.headers.get('x-backup-unencrypted-warning')).toBeNull();
        const encZipBytes = new Uint8Array(await encRes.arrayBuffer());

        const unpacked = unzipSync(encZipBytes);
        const manifest = JSON.parse(Buffer.from(unpacked['manifest.json']).toString('utf8')) as BackupManifestV3;
        expect(manifest.encryption).toMatchObject({ algorithm: 'aes-256-gcm', kdf: 'scrypt' });
        expect(manifest.warnings).not.toContain('BACKUP_UNENCRYPTED');
        expect(JSON.stringify(manifest)).not.toContain(secret);
        expect(Buffer.from(unpacked['data/errorItems.ndjson']).toString('utf8')).not.toContain('SecretMarker');

        await clearUserData();

        // 3. 缺少口令被拒收
        const missingRes = await importZipBackup(encZipBytes);
        expect(missingRes.response.status).toBe(400);
        expect(missingRes.data.code).toBe('BACKUP_PASSPHRASE_REQUIRED');
        expect(await database.errorItem.count()).toBe(0);

        // 4. 错误口令被拒收
        const wrongRes = await importZipBackup(encZipBytes, '', 'wrong-passphrase');
        expect(wrongRes.response.status).toBe(400);
        expect(wrongRes.data.code).toBe('BACKUP_INVALID_PASSPHRASE');
        expect(await database.errorItem.count()).toBe(0);

        // 5. 正确口令完整导入恢复
        const okRes = await importZipBackup(encZipBytes, '', secret);
        expect(okRes.response.status).toBe(200);
        const restored = await database.errorItem.findFirstOrThrow({ where: { userId: 'user-1', questionText: '隐私加密测试题干_SecretMarker' } });
        expect(restored.answerText).toBe('42');
        expect(restored.originalImageUrl).toContain('data:image/png;base64,');
    });

    it('历史备份向后兼容：无 systemParentPath 降级根级、同科重名系统标签优先选叶子并记 warning，存在非系统标签或带错误路径仍报错', async () => {
        // 1. 准备目标库的系统标签树：
        //    - 一元一次方程：一个带子节点的章节节点（ID 字典序更小）+ 一个叶子节点（ID 字典序更大）
        //    - 二次函数：两个同为叶子的重名系统节点（应按 ID 升序选首个）
        await clearUserData();
        await database.knowledgeTag.createMany({
            data: [
                { id: 'sys-00-root', name: '代数模块', subject: 'math', isSystem: true, parentId: null },
                { id: 'sys-01-chapter', name: '一元一次方程', subject: 'math', isSystem: true, parentId: 'sys-00-root' },
                { id: 'sys-02-child', name: '移项解法', subject: 'math', isSystem: true, parentId: 'sys-01-chapter' },
                { id: 'sys-99-leaf', name: '一元一次方程', subject: 'math', isSystem: true, parentId: null },
                { id: 'sys-fn-b', name: '二次函数', subject: 'math', isSystem: true, parentId: null },
                { id: 'sys-fn-a', name: '二次函数', subject: 'math', isSystem: true, parentId: null },
            ],
        });

        // 2. 旧版 JSON：customTags 缺省 subject/order/code/systemParentPath，errorItems 标签无 systemPath 但带 subject
        const legacyJson = {
            version: 2,
            exportedAt: '2025-12-01T00:00:00.000Z',
            user: { id: 'old-u', email: mocks.session.user.email },
            customTags: [
                { id: 'old-custom-1', name: '历史自定义标签', parentId: 'deleted-old-sys-parent' },
            ],
            errorItems: [
                {
                    id: 'old-item-1',
                    userId: 'old-u',
                    subjectId: null,
                    originalImageUrl: 'data:image/png;base64,dGVzdA==',
                    questionText: '解方程 2x=6',
                    masteryLevel: 0,
                    createdAt: '2025-12-01T00:00:00.000Z',
                    updatedAt: '2025-12-01T00:00:00.000Z',
                    tags: [
                        { id: 'old-custom-1', name: '历史自定义标签', subject: 'math' },
                        { id: 'deleted-sys-1', name: '一元一次方程', subject: 'math' },
                        { id: 'deleted-sys-2', name: '二次函数', subject: 'math' },
                    ],
                },
            ],
        };

        const imported = await importBackup(legacyJson);
        expect(imported.warnings).toContain('LEGACY_CUSTOM_TAG_PARENT_DETACHED');
        expect(imported.warnings).toContain('LEGACY_SYSTEM_TAG_APPROXIMATED');

        const restoredCustomTag = await database.knowledgeTag.findFirstOrThrow({
            where: { userId: 'user-1', name: '历史自定义标签' },
        });
        expect(restoredCustomTag).toMatchObject({ subject: 'math', parentId: null, order: 0, code: null });

        const restoredItem = await database.errorItem.findFirstOrThrow({
            where: { userId: 'user-1', questionText: '解方程 2x=6' },
            include: { tags: true },
        });
        expect(restoredItem.tags.map((tag) => tag.id).sort()).toEqual([
            restoredCustomTag.id,
            'sys-99-leaf',
            'sys-fn-a',
        ].sort());

        // 3. 若新版备份携带了不存在的 systemParentPath，则保持严格并抛 409 BACKUP_TAG_AMBIGUOUS
        const strictRes = await IMPORT(new Request('http://localhost/api/import', {
            method: 'POST',
            body: JSON.stringify({
                ...legacyJson,
                customTags: [{
                    id: 'strict-custom',
                    name: '严格带路径标签',
                    subject: 'math',
                    parentId: 'deleted-old-sys-parent',
                    systemParentPath: ['不存在的教材路径'],
                    order: 0,
                    code: null,
                }],
                errorItems: [],
            }),
            headers: { 'Content-Type': 'application/json' },
        }));
        expect(strictRes.status).toBe(409);
        expect((await strictRes.json()).code).toBe('BACKUP_TAG_AMBIGUOUS');

        // 4. 若同科存在非系统自定义标签冲突，则无 systemPath 时仍抛 409 BACKUP_TAG_AMBIGUOUS
        await database.knowledgeTag.create({
            data: { name: '一元一次方程', subject: 'math', userId: 'user-1', isSystem: false },
        });
        const customConflictRes = await IMPORT(new Request('http://localhost/api/import', {
            method: 'POST',
            body: JSON.stringify({
                version: 2,
                exportedAt: '2025-12-01T00:00:00.000Z',
                user: { id: 'old-u', email: mocks.session.user.email },
                customTags: [],
                errorItems: [{
                    id: 'old-item-conflict',
                    userId: 'old-u',
                    subjectId: null,
                    originalImageUrl: 'data:image/png;base64,dGVzdA==',
                    questionText: '冲突题目',
                    masteryLevel: 0,
                    createdAt: '2025-12-01T00:00:00.000Z',
                    updatedAt: '2025-12-01T00:00:00.000Z',
                    tags: [{ id: 'deleted-sys-1', name: '一元一次方程', subject: 'math' }],
                }],
            }),
            headers: { 'Content-Type': 'application/json' },
        }));
        expect(customConflictRes.status).toBe(409);
        expect((await customConflictRes.json()).code).toBe('BACKUP_TAG_AMBIGUOUS');

        // 5. v3 ZIP 同样支持无 systemParentPath 降级与同科重名系统标签近似匹配并入库 warnings
        await database.knowledgeTag.deleteMany({ where: { isSystem: false } });
        const customLine = JSON.stringify({
            id: 'zip-old-custom',
            name: 'ZIP历史自定义',
            userId: 'old-u',
            subject: 'math',
            parentId: 'missing-sys-root',
            order: 1,
            code: null,
        });
        const itemLine = JSON.stringify({
            id: 'zip-old-item',
            userId: 'old-u',
            subjectId: null,
            originalImageUrl: '',
            questionText: 'ZIP历史题目',
            masteryLevel: 0,
            tags: [{ id: 'deleted-sys-1', name: '一元一次方程', subject: 'math' }],
        });
        const userLine = JSON.stringify({ id: 'old-u', email: mocks.session.user.email });
        const entries: Record<string, Uint8Array> = {
            'data/users.ndjson': Buffer.from(`${userLine}\n`, 'utf8'),
            'data/customTags.ndjson': Buffer.from(`${customLine}\n`, 'utf8'),
            'data/errorItems.ndjson': Buffer.from(`${itemLine}\n`, 'utf8'),
        };
        const filesMeta: Record<string, { size: number; sha256: string }> = {};
        for (const [name, buf] of Object.entries(entries)) {
            filesMeta[name] = {
                size: buf.byteLength,
                sha256: crypto.createHash('sha256').update(buf).digest('hex'),
            };
        }
        const zipManifest = {
            formatVersion: 3,
            appVersion: '3',
            exportedAt: '2025-12-01T00:00:00.000Z',
            scope: 'user',
            user: { id: 'old-u', email: mocks.session.user.email },
            counts: {},
            derivedCounts: {},
            files: filesMeta,
            warnings: [],
        };
        entries['manifest.json'] = Buffer.from(JSON.stringify(zipManifest), 'utf8');
        const legacyV3Zip = zipSync(entries);
        const v3LegacyRes = await importZipBackup(legacyV3Zip);
        expect(v3LegacyRes.response.status).toBe(200);
        expect(v3LegacyRes.data.warnings).toContain('LEGACY_CUSTOM_TAG_PARENT_DETACHED');
        expect(v3LegacyRes.data.warnings).toContain('LEGACY_SYSTEM_TAG_APPROXIMATED');
    });

    it('同一 v3 ZIP 连续导入两次完全幂等不重复（错题/试卷/家长卷/批改任务/变式运行/练习记录）', async () => {
        const child = await database.learner.create({
            data: { id: 'idem-child', userId: 'user-1', kind: 'child', name: '幂等孩子' },
        });
        const cls = await database.gradingClass.create({
            data: { id: 'idem-cls', userId: 'user-1', name: '幂等一班' },
        });
        const stu = await database.gradingStudent.create({
            data: { id: 'idem-stu', classId: cls.id, name: '张同学', studentNo: '01' },
        });
        await database.learner.create({
            data: { id: 'idem-ln-stu', userId: 'user-1', kind: 'student', name: '张同学', gradingStudentId: stu.id },
        });
        const paper = await database.examPaper.create({
            data: {
                id: 'idem-exam',
                userId: 'user-1',
                learnerId: child.id,
                title: '幂等测试卷',
                status: 'ready',
                scope: 'all',
                difficulty: 'medium',
                requestedCount: 1,
                subjectIds: JSON.stringify(['math']),
                questions: {
                    create: {
                        id: 'idem-exam-q',
                        order: 0,
                        errorItemId: 'item-1',
                        sourceShortId: 'AbC234',
                        status: 'ready',
                        questionText: '试卷变式',
                    },
                },
            },
        });
        expect(paper.id).toBe('idem-exam');
        await database.parentPaper.create({
            data: {
                id: 'idem-pp',
                userId: 'user-1',
                learnerId: child.id,
                title: '幂等家长卷',
                status: 'confirmed',
                pages: { create: { id: 'idem-ppp', position: 0, imageUrl: 'data:image/png;base64,dGVzdA==' } },
                questions: {
                    create: {
                        id: 'idem-ppq',
                        position: 0,
                        number: '1',
                        questionText: '求解 x + 2 = 5',
                        verdict: 'wrong',
                        importedErrorItemId: 'item-1',
                    },
                },
            },
        });
        await database.gradingTask.create({
            data: {
                id: 'idem-gt',
                userId: 'user-1',
                classId: cls.id,
                title: '幂等批改',
                subjectName: '数学',
                questions: { create: { id: 'idem-gkq', order: 0, number: '1', answer: '3' } },
                submissions: {
                    create: {
                        id: 'idem-gs',
                        studentId: stu.id,
                        status: 'confirmed',
                        images: '[]',
                        results: { create: { id: 'idem-gr', keyQuestionId: 'idem-gkq', verdict: 'wrong', errorItemId: 'item-1' } },
                    },
                },
            },
        });
        const run = await database.variantRun.create({
            data: {
                id: 'idem-vr',
                userId: 'user-1',
                kind: 'practice',
                mode: 'pipeline',
                status: 'completed',
                title: '幂等变式',
                errorItemId: 'item-1',
            },
        });
        const vitem = await database.variantItem.create({
            data: {
                id: 'idem-vi',
                runId: run.id,
                index: 0,
                status: 'approved',
                questionText: '变式1',
                sourceItemId: 'item-1',
            },
        });
        await database.variantStageLog.create({
            data: { id: 'idem-vs', runId: run.id, itemId: vitem.id, stage: 'generate', status: 'ok' },
        });

        const zipBytes = await exportZipBackup();
        await clearUserData();

        const first = await importZipBackup(zipBytes);
        expect(first.response.status).toBe(200);
        expect(first.data.stats).toMatchObject({
            errorItemsCreated: 1,
            examPapersCreated: 1,
            practiceRecordsCreated: 1,
            parentPapersCreated: 1,
            gradingTasksCreated: 1,
            variantRunsCreated: 1,
            duplicateErrorItems: 0,
        });

        const snapshotCounts = async () => ({
            errorItems: await database.errorItem.count(),
            examPapers: await database.examPaper.count(),
            examQuestions: await database.examQuestion.count(),
            practiceRecords: await database.practiceRecord.count(),
            parentPapers: await database.parentPaper.count(),
            parentPaperPages: await database.parentPaperPage.count(),
            parentPaperQuestions: await database.parentPaperQuestion.count(),
            gradingTasks: await database.gradingTask.count(),
            gradingKeyQuestions: await database.gradingKeyQuestion.count(),
            gradingSubmissions: await database.gradingSubmission.count(),
            gradingResults: await database.gradingResult.count(),
            variantRuns: await database.variantRun.count(),
            variantItems: await database.variantItem.count(),
            variantStageLogs: await database.variantStageLog.count(),
        });
        const afterFirst = await snapshotCounts();

        // 第二次直接重复导入同一份 v3 ZIP：所有统计均为 0 且表行数完全不变
        const second = await importZipBackup(zipBytes);
        expect(second.response.status).toBe(200);
        expect(second.data.stats).toMatchObject({
            learnersCreated: 0,
            errorItemsCreated: 0,
            duplicateErrorItems: 0,
            examPapersCreated: 0,
            practiceRecordsCreated: 0,
            parentPapersCreated: 0,
            gradingTasksCreated: 0,
            variantRunsCreated: 0,
        });
        expect(await snapshotCounts()).toEqual(afterFirst);
    });

    it('恢复时自动解除已归档孩子的归档状态；活跃孩子超 3 个时保留全部孩子并提示 CHILD_LEARNER_LIMIT_EXCEEDED', async () => {
        const archivedLater = await database.learner.create({
            data: { id: 'child-unarchive', userId: 'user-1', kind: 'child', name: '待恢复孩子', order: 0 },
        });
        const zipBytes = await exportZipBackup();

        // 当前库把该孩子归档，并另外创建 3 个活跃孩子（恰好达到 MAX_CHILD_LEARNERS）
        await database.learner.update({
            where: { id: archivedLater.id },
            data: { archivedAt: new Date('2026-11-01T00:00:00.000Z') },
        });
        for (let i = 1; i <= MAX_CHILD_LEARNERS; i++) {
            await database.learner.create({
                data: { id: `extra-child-${i}`, userId: 'user-1', kind: 'child', name: `新孩子${i}`, order: i },
            });
        }

        const res = await importZipBackup(zipBytes);
        expect(res.response.status).toBe(200);
        expect(res.data.warnings).toContain('CHILD_LEARNER_LIMIT_EXCEEDED');

        const restoredChild = await database.learner.findUniqueOrThrow({ where: { id: archivedLater.id } });
        expect(restoredChild.archivedAt).toBeNull();

        const activeChildren = await database.learner.findMany({
            where: { userId: 'user-1', kind: 'child', archivedAt: null },
        });
        expect(activeChildren).toHaveLength(MAX_CHILD_LEARNERS + 1);
    });

    it('unpackBackupZipStream 对压缩包体积、条目数及解压总大小超限均拒收 (413 BACKUP_TOO_LARGE) 并清理 tmp 目录', async () => {
        const isolatedTmp = mkdtempSync(join(directory, 'isolated-tmp-'));
        const prevTmpDir = process.env.TMPDIR;
        process.env.TMPDIR = isolatedTmp;
        try {
            const smallEntries = {
                'a.txt': Buffer.from('hello'),
                'b.txt': Buffer.from('world'),
                'c.txt': Buffer.from('12345'),
                'd.txt': Buffer.from('67890'),
            };
            const normalZip = zipSync(smallEntries);

            // 1a. Uint8Array 压缩包体积超限
            await expect(archiveRead.unpackBackupZipStream(normalZip, {
                limits: { maxZipBytes: 32 },
            })).rejects.toMatchObject({ name: 'BackupError', code: 'BACKUP_TOO_LARGE', status: 413 });
            expect(readdirSync(isolatedTmp)).toEqual([]);

            // 1b. ReadableStream 压缩包体积超限
            const webStream = Readable.toWeb(Readable.from([normalZip.subarray(0, 20), normalZip.subarray(20)])) as ReadableStream<Uint8Array>;
            await expect(archiveRead.unpackBackupZipStream(webStream, {
                limits: { maxZipBytes: 32 },
            })).rejects.toMatchObject({ name: 'BackupError', code: 'BACKUP_TOO_LARGE', status: 413 });
            expect(readdirSync(isolatedTmp)).toEqual([]);

            // 2. 条目数超限
            await expect(archiveRead.unpackBackupZipStream(normalZip, {
                limits: { maxEntries: 2 },
            })).rejects.toMatchObject({ name: 'BackupError', code: 'BACKUP_TOO_LARGE', status: 413 });
            expect(readdirSync(isolatedTmp)).toEqual([]);

            // 3. 高压缩比解压总字节数超限（ZIP 炸弹防护）
            const bombPayload = Buffer.alloc(64 * 1024, 0x41);
            const bombZip = zipSync({ 'bomb.txt': bombPayload }, { level: 9 });
            expect(bombZip.byteLength).toBeLessThan(2048);
            await expect(archiveRead.unpackBackupZipStream(bombZip, {
                limits: { maxZipBytes: 4096, maxUncompressedBytes: 1024 },
            })).rejects.toMatchObject({ name: 'BackupError', code: 'BACKUP_TOO_LARGE', status: 413 });
            expect(readdirSync(isolatedTmp)).toEqual([]);

            // 4. API /api/import 对 BACKUP_TOO_LARGE 返回 413 与对应 code
            const spy = vi.spyOn(archiveRead, 'unpackBackupZipStream').mockRejectedValueOnce(
                new BackupError('BACKUP_TOO_LARGE', 'Backup archive exceeds limit', 413),
            );
            try {
                const { response, data } = await importZipBackup(normalZip);
                expect(response.status).toBe(413);
                expect(data.code).toBe('BACKUP_TOO_LARGE');
            } finally {
                spy.mockRestore();
            }
        } finally {
            if (prevTmpDir === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = prevTmpDir;
            rmSync(isolatedTmp, { recursive: true, force: true });
        }
    });
});
