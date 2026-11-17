// @vitest-environment node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

import { GET as EXPORT } from '@/app/api/export/route';
import { POST as IMPORT } from '@/app/api/import/route';
import { sanitizeFigureSvg } from '@/lib/figure-svg';
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

async function importZipBackup(zipBytes: Uint8Array, query = '') {
    const body = new Blob([Buffer.from(zipBytes)], { type: 'application/zip' });
    const form = new FormData();
    form.append('file', body, 'backup.zip');
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
    await database.learningPathStep.deleteMany({});
    await database.learningPath.deleteMany({});
    await database.knowledgeMastery.deleteMany({});
    await database.parentPaperQuestion.deleteMany({});
    await database.parentPaperPage.deleteMany({});
    await database.parentPaper.deleteMany({});
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
    delete process.env.CONFIG_DIR;
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
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
                questions: { create: { id: 'gkq-v3', order: 0, number: '1', answer: '3' } },
            },
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
        await database.learningPath.create({
            data: {
                userId: 'user-1', studentKey: childActive.id, studentName: '小明', evidenceHash: 'eh1',
                steps: { create: {
                    position: 0, type: 'variant_practice', title: '巩固', reason: '高频错题',
                    knowledgePoints: '["方程"]', errorItemIds: JSON.stringify(['item-1']),
                    variantRunId: run.id, teacherNote: '周末重练',
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
        expect(manifest.derivedCounts).toMatchObject({ knowledgeMasteries: 2, learningPaths: 1, learningPathSteps: 1 });
        expect(manifest.files[`media/${hashA}`]).toBeDefined();
        expect(manifest.files[`media/${hashB}`]).toBeDefined();
        expect(crypto.createHash('sha256').update(unpacked[`media/${hashA}`]).digest('hex')).toBe(hashA);
        expect(crypto.createHash('sha256').update(unpacked[`media/${hashB}`]).digest('hex')).toBe(hashB);

        // 清空除 User 外的全部业务数据，再导入 ZIP
        await clearUserData();
        const { response, data } = await importZipBackup(zipBytes);
        expect(response.status).toBe(200);
        expect(data.warnings).toContain('LEGACY_REVIEW_SCHEDULE_IGNORED');
        expect(data.stats).toMatchObject({
            learnersCreated: 3, errorItemsCreated: 2, reviewSchedulesCreated: 0,
            parentPapersCreated: 1, gradingTasksCreated: 1, variantRunsCreated: 1,
            knowledgeMasteriesImported: 2, learningPathsCreated: 1,
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
        expect(JSON.parse(restoredPath.steps[0].errorItemIds!)).toEqual([activeItems[0].id]);
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
        await clearUserData();
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
        expect(importRes.status).toBe(200);
        expect(await database.errorItem.count({ where: { userId: 'user-1' } })).toBe(imagesCount + 1);
        expect(peakDelta).toBeLessThan(150 * 1024 * 1024);
    }, 60000);
});
