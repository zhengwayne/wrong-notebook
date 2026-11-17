// @vitest-environment node
/**
 * 在真实 SQLite 副本上验证学习者迁移与回填：不删除任何记录，同名学生不瞎匹配，撤回可逆。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, mkdirSync, cpSync as copy } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { confirmSubmission } from '@/lib/grading-service';
import { applyLearnerBackfill, revertLearnerBackfill } from '@/lib/learner-backfill';
import { ChildLearnerLimitError, MAX_CHILD_LEARNERS, createChildLearner, studentKeyOf, LEARNER_KIND } from '@/lib/learners';
import { resolveStudent } from '@/lib/learning-path/service';
import { SELF_STUDENT_KEY } from '@/lib/learning-path/types';

const REPO = resolve('.');
const PRISMA_BIN = resolve('node_modules/prisma/build/index.js');
const NEW_MIGRATION = '20261117130000_add_learners';

function migrateDeploy(url: string, prismaRoot: string) {
    execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')], {
        env: { ...process.env, DATABASE_URL: url },
        cwd: REPO,
        stdio: 'pipe',
    });
}

function makePrismaTree(directory: string, includeNewMigration: boolean): string {
    const root = join(directory, 'prisma');
    mkdirSync(join(root, 'migrations'), { recursive: true });
    copy(join(REPO, 'prisma', 'schema.prisma'), join(root, 'schema.prisma'));
    copy(join(REPO, 'prisma', 'migrations', 'migration_lock.toml'), join(root, 'migrations', 'migration_lock.toml'));
    for (const name of readdirSync(join(REPO, 'prisma', 'migrations'))) {
        if (name === 'migration_lock.toml') continue;
        if (!includeNewMigration && name === NEW_MIGRATION) continue;
        copy(join(REPO, 'prisma', 'migrations', name), join(root, 'migrations', name), { recursive: true });
    }
    return root;
}

async function seedRealistic(db: PrismaClient, withLearnerColumn: boolean) {
    // withLearnerColumn 只影响是否走 Prisma 创建（新库）；旧库用 raw SQL 避免写入尚不存在的列
    if (!withLearnerColumn) {
        const now = new Date().toISOString();
        await db.$executeRawUnsafe(
            `INSERT INTO "User" ("id","email","password","name","role","isActive","gradeRecognitionMode","confirmBeforeImport","questionDuplicateThreshold","masteryThreshold","variantPipelineEnabled","enableGeogebra","enableSvgAnimation","themePreference","createdAt","updatedAt") VALUES ('teacher-1','teacher@example.com','x','王老师','user',1,'fixed',0,90,50,1,0,1,'system','${now}','${now}')`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "Subject" ("id","name","stage","subjectKey","userId","createdAt","updatedAt") VALUES
            ('nb-zhang','张三·数学','junior_high','math','teacher-1','${now}','${now}'),
            ('nb-li','李四·数学','junior_high','math','teacher-1','${now}','${now}'),
            ('nb-self','我的数学','junior_high','math','teacher-1','${now}','${now}'),
            ('nb-ghost','赵六·英语','junior_high','english','teacher-1','${now}','${now}'),
            ('nb-liu','刘七·物理','senior_high','physics','teacher-1','${now}','${now}')`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "ErrorItem" ("id","shortId","userId","subjectId","originalImageUrl","questionText","createdAt","updatedAt","hasFigure","masteryLevel") VALUES
            ('item-z1','Z00001','teacher-1','nb-zhang','','张三题1','${now}','${now}',0,0),
            ('item-z2','Z00002','teacher-1','nb-zhang','','张三题2','${now}','${now}',0,0),
            ('item-l1','L00001','teacher-1','nb-li','','李四题1','${now}','${now}',0,0),
            ('item-self','S00001','teacher-1','nb-self','','老师自己的题','${now}','${now}',0,0),
            ('item-ghost','G00001','teacher-1','nb-ghost','','没有学生的笔记本','${now}','${now}',0,0),
            ('item-liu','U00001','teacher-1','nb-liu','','同名学生不匹配','${now}','${now}',0,0)`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "PracticeRecord" ("id","userId","errorItemId","result","source","createdAt") VALUES
            ('pr-z1','teacher-1','item-z1','wrong','practice','${now}'),
            ('pr-self','teacher-1','item-self','correct','practice','${now}')`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "GradingClass" ("id","userId","name","createdAt","updatedAt") VALUES
            ('class-a','teacher-1','初二1班','${now}','${now}'),
            ('class-b','teacher-1','初二2班','${now}','${now}')`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "GradingStudent" ("id","classId","name","studentNo","order","createdAt") VALUES
            ('stu-zhang','class-a','张三','01',1,'${now}'),
            ('stu-li','class-a','李四','02',2,'${now}'),
            ('stu-wang','class-a','王五','03',3,'${now}'),
            ('stu-liu-a','class-a','刘七','07',4,'${now}'),
            ('stu-liu-b','class-b','刘七','07',1,'${now}')`,
        );
        return;
    }

    await db.user.create({ data: { id: 'teacher-1', email: 'teacher@example.com', password: 'x', name: '王老师' } });
    await db.subject.createMany({
        data: [
            { id: 'nb-zhang', name: '张三·数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
            { id: 'nb-li', name: '李四·数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
            { id: 'nb-self', name: '我的数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
            { id: 'nb-ghost', name: '赵六·英语', stage: 'junior_high', subjectKey: 'english', userId: 'teacher-1' },
            { id: 'nb-liu', name: '刘七·物理', stage: 'senior_high', subjectKey: 'physics', userId: 'teacher-1' },
        ],
    });
    await db.errorItem.createMany({
        data: [
            { id: 'item-z1', shortId: 'Z00001', userId: 'teacher-1', subjectId: 'nb-zhang', originalImageUrl: '', questionText: '张三题1' },
            { id: 'item-z2', shortId: 'Z00002', userId: 'teacher-1', subjectId: 'nb-zhang', originalImageUrl: '', questionText: '张三题2' },
            { id: 'item-l1', shortId: 'L00001', userId: 'teacher-1', subjectId: 'nb-li', originalImageUrl: '', questionText: '李四题1' },
            { id: 'item-self', shortId: 'S00001', userId: 'teacher-1', subjectId: 'nb-self', originalImageUrl: '', questionText: '老师自己的题' },
            { id: 'item-ghost', shortId: 'G00001', userId: 'teacher-1', subjectId: 'nb-ghost', originalImageUrl: '', questionText: '没有学生的笔记本' },
            { id: 'item-liu', shortId: 'U00001', userId: 'teacher-1', subjectId: 'nb-liu', originalImageUrl: '', questionText: '同名学生不匹配' },
        ],
    });
    await db.practiceRecord.createMany({
        data: [
            { id: 'pr-z1', userId: 'teacher-1', errorItemId: 'item-z1', result: 'wrong' },
            { id: 'pr-self', userId: 'teacher-1', errorItemId: 'item-self', result: 'correct' },
        ],
    });
    await db.gradingClass.create({
        data: {
            id: 'class-a',
            userId: 'teacher-1',
            name: '初二1班',
            students: {
                create: [
                    { id: 'stu-zhang', name: '张三', studentNo: '01', order: 1 },
                    { id: 'stu-li', name: '李四', studentNo: '02', order: 2 },
                    { id: 'stu-wang', name: '王五', studentNo: '03', order: 3 },
                    { id: 'stu-liu-a', name: '刘七', studentNo: '07', order: 4 },
                ],
            },
        },
    });
    await db.gradingClass.create({
        data: {
            id: 'class-b',
            userId: 'teacher-1',
            name: '初二2班',
            students: { create: [{ id: 'stu-liu-b', name: '刘七', studentNo: '07', order: 1 }] },
        },
    });
}

async function counts(db: PrismaClient) {
    return {
        users: await db.user.count(),
        subjects: await db.subject.count(),
        errorItems: await db.errorItem.count(),
        practiceRecords: await db.practiceRecord.count(),
        gradingStudents: await db.gradingStudent.count(),
        gradingClasses: await db.gradingClass.count(),
    };
}

describe('学习者迁移与回填', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xueji-learner-backfill-'));

    afterAll(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('在旧库副本上执行迁移后行数不变，再回填只挂唯一姓名的学生', async () => {
        const oldRoot = makePrismaTree(join(directory, 'old-tree'), false);
        const originalDb = join(directory, 'realistic-before.db');
        const originalUrl = `file:${originalDb}`;
        migrateDeploy(originalUrl, oldRoot);
        const original = new PrismaClient({ datasources: { db: { url: originalUrl } } });
        await seedRealistic(original, false);
        const before = {
            users: Number((await original.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "User"'))[0].c),
            subjects: Number((await original.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "Subject"'))[0].c),
            errorItems: Number((await original.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "ErrorItem"'))[0].c),
            practiceRecords: Number((await original.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "PracticeRecord"'))[0].c),
            gradingStudents: Number((await original.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "GradingStudent"'))[0].c),
        };
        await original.$disconnect();

        const copyDb = join(directory, 'realistic-after.db');
        cpSync(originalDb, copyDb);
        const newRoot = makePrismaTree(join(directory, 'new-tree'), true);
        const copyUrl = `file:${copyDb}`;
        migrateDeploy(copyUrl, newRoot);

        const db = new PrismaClient({ datasources: { db: { url: copyUrl } } });
        mocks.prisma = db;
        const afterMigrate = await counts(db);
        expect(afterMigrate).toEqual({ ...before, gradingClasses: 2 });
        expect(await db.errorItem.count({ where: { learnerId: { not: null } } })).toBe(0);

        const result = await applyLearnerBackfill(db);
        expect(result.errorItemsLinked).toBe(3); // 张三两题 + 李四一题
        expect(result.practiceRecordsLinked).toBe(1); // pr-z1
        expect(result.skippedAmbiguousNames.some((name) => name.endsWith(':刘七'))).toBe(true);
        expect(await counts(db)).toEqual(afterMigrate);

        const zhang = await db.learner.findUnique({ where: { gradingStudentId: 'stu-zhang' } });
        const li = await db.learner.findUnique({ where: { gradingStudentId: 'stu-li' } });
        expect(zhang).toBeTruthy();
        expect(li).toBeTruthy();
        expect(studentKeyOf(zhang!)).toBe('stu-zhang');

        const items = await db.errorItem.findMany();
        const byId = Object.fromEntries(items.map((item) => [item.id, item.learnerId]));
        expect(byId['item-z1']).toBe(zhang!.id);
        expect(byId['item-z2']).toBe(zhang!.id);
        expect(byId['item-l1']).toBe(li!.id);
        expect(byId['item-self']).toBeNull();
        expect(byId['item-ghost']).toBeNull();
        expect(byId['item-liu']).toBeNull();

        const records = await db.practiceRecord.findMany();
        expect(records.find((row) => row.id === 'pr-z1')?.learnerId).toBe(zhang!.id);
        expect(records.find((row) => row.id === 'pr-self')?.learnerId).toBeNull();

        // 原本的库文件没有被迁移或回填
        const originalCheck = new PrismaClient({ datasources: { db: { url: originalUrl } } });
        const originalCols = await originalCheck.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ErrorItem")');
        expect(originalCols.some((col) => col.name === 'learnerId')).toBe(false);
        expect(Number((await originalCheck.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM "ErrorItem"'))[0].c)).toBe(before.errorItems);
        await originalCheck.$disconnect();
        const copyCols = await db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ErrorItem")');
        expect(copyCols.some((col) => col.name === 'learnerId')).toBe(true);

        const resolved = await resolveStudent('teacher-1', 'stu-zhang');
        expect(resolved?.studentKey).toBe('stu-zhang');
        expect(resolved?.studentName).toBe('张三');
        const self = await resolveStudent('teacher-1', SELF_STUDENT_KEY);
        expect(self?.studentKey).toBe(SELF_STUDENT_KEY);

        const batchId = result.batchId;
        const reverted = await revertLearnerBackfill(db, batchId);
        expect(reverted.errorItemsRestored).toBe(3);
        expect(reverted.practiceRecordsRestored).toBe(1);
        expect(await db.errorItem.count({ where: { learnerId: { not: null } } })).toBe(0);
        expect(await counts(db)).toEqual(afterMigrate);

        const second = await applyLearnerBackfill(db);
        expect(second.errorItemsLinked).toBe(3);
        const third = await applyLearnerBackfill(db);
        expect(third.errorItemsLinked).toBe(0);

        await db.$disconnect();
    }, 120000);

    it('改卷确认会给新错题挂上学习者，孩子档案最多 3 个', async () => {
        const root = makePrismaTree(join(directory, 'confirm-tree'), true);
        const url = `file:${join(directory, 'confirm.db')}`;
        migrateDeploy(url, root);
        const db = new PrismaClient({ datasources: { db: { url } } });
        mocks.prisma = db;

        await db.user.create({ data: { id: 'u1', email: 't2@example.com', password: 'x', name: '老师' } });
        const cls = await db.gradingClass.create({
            data: { id: 'c1', userId: 'u1', name: '一班', students: { create: { id: 'stu-1', name: '小明', studentNo: '01' } } },
        });
        await db.gradingTask.create({
            data: {
                id: 'task-1',
                userId: 'u1',
                classId: cls.id,
                title: '单元测验',
                subjectName: '数学',
                questions: { create: { id: 'kq-1', order: 1, number: '1', type: 'objective', maxScore: 5, answer: 'A' } },
            },
        });
        await db.gradingSubmission.create({
            data: {
                id: 'sub-1',
                taskId: 'task-1',
                studentId: 'stu-1',
                images: '[]',
                status: 'graded',
                results: { create: { keyQuestionId: 'kq-1', verdict: 'wrong', score: 0, studentAnswer: 'B', reason: '计算错' } },
            },
        });

        const confirmed = await confirmSubmission('sub-1', 'u1');
        expect(confirmed).toEqual({ importedCount: 1 });
        const imported = await db.errorItem.findMany({ where: { userId: 'u1' } });
        expect(imported).toHaveLength(1);
        const learner = await db.learner.findUnique({ where: { gradingStudentId: 'stu-1' } });
        expect(learner).toBeTruthy();
        expect(imported[0].learnerId).toBe(learner!.id);
        expect(studentKeyOf(learner!)).toBe('stu-1');
        const notebook = await db.subject.findFirst({ where: { userId: 'u1' } });
        expect(notebook?.name).toBe('小明·数学');

        await createChildLearner(db, 'u1', '孩子一');
        await createChildLearner(db, 'u1', '孩子二');
        await createChildLearner(db, 'u1', '孩子三');
        await expect(createChildLearner(db, 'u1', '孩子四')).rejects.toBeInstanceOf(ChildLearnerLimitError);
        expect(MAX_CHILD_LEARNERS).toBe(3);
        expect(LEARNER_KIND.child).toBe('child');

        await db.$disconnect();
    }, 120000);
});
