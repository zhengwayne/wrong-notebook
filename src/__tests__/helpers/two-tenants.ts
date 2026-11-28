import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');

export interface IsolatedTestDb {
    directory: string;
    dbFile: string;
    dbUrl: string;
    db: PrismaClient;
    cleanup: () => Promise<void>;
}

/**
 * 在系统临时目录创建完成全部正式迁移的独立 SQLite 测试库（开启 foreign_keys=ON）。
 */
export function createIsolatedTestDb(prefix = 'two-tenants-'): IsolatedTestDb {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dbFile = path.join(directory, 'test.db');
    const dbUrl = `file:${dbFile.split(path.sep).join('/')}?connection_limit=1`;

    execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: dbUrl },
        cwd: REPO_ROOT,
        stdio: 'pipe',
    });

    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    return {
        directory,
        dbFile,
        dbUrl,
        db,
        cleanup: async () => {
            await db.$disconnect();
            fs.rmSync(directory, { recursive: true, force: true });
        },
    };
}

export interface TenantSeed {
    user: { id: string; email: string; name: string };
    session: { user: { id: string; email: string; name: string; role: string }; expires: string };
    notebook: { id: string; name: string };
    selfLearner: { id: string };
    children: {
        first: { id: string; name: string };
        second: { id: string; name: string };
    };
    classes: {
        classA: { id: string; name: string };
        classB: { id: string; name: string };
    };
    sameNameStudents: {
        inClassA: { gradingStudentId: string; learnerId: string; name: string };
        inClassB: { gradingStudentId: string; learnerId: string; name: string };
    };
}

export interface TwoTenantsContext {
    alice: TenantSeed;
    bob: TenantSeed;
}

async function seedTenant(
    db: PrismaClient,
    options: {
        prefix: string;
        email: string;
        name: string;
        childNames: [string, string];
    },
): Promise<TenantSeed> {
    const user = await db.user.create({
        data: {
            id: `${options.prefix}-user`,
            email: options.email,
            password: 'hashed-test-password',
            name: options.name,
            personas: '["teacher","parent","self"]',
            activePersona: 'parent',
            personasConfirmedAt: new Date(),
        },
    });
    const notebook = await db.subject.create({
        data: {
            id: `${options.prefix}-nb-math`,
            name: '数学',
            stage: 'junior_high',
            subjectKey: 'math',
            userId: user.id,
        },
    });
    const selfLearner = await db.learner.create({
        data: {
            id: `${options.prefix}-self`,
            userId: user.id,
            kind: 'self',
            name: '本人',
            order: 0,
        },
    });
    const childFirst = await db.learner.create({
        data: {
            id: `${options.prefix}-child-1`,
            userId: user.id,
            kind: 'child',
            name: options.childNames[0],
            order: 0,
        },
    });
    const childSecond = await db.learner.create({
        data: {
            id: `${options.prefix}-child-2`,
            userId: user.id,
            kind: 'child',
            name: options.childNames[1],
            order: 1,
        },
    });
    const classA = await db.gradingClass.create({
        data: { id: `${options.prefix}-class-a`, userId: user.id, name: '一班' },
    });
    const classB = await db.gradingClass.create({
        data: { id: `${options.prefix}-class-b`, userId: user.id, name: '二班' },
    });
    const stuA = await db.gradingStudent.create({
        data: { id: `${options.prefix}-stu-a`, classId: classA.id, name: '张三', studentNo: '01', order: 0 },
    });
    const stuB = await db.gradingStudent.create({
        data: { id: `${options.prefix}-stu-b`, classId: classB.id, name: '张三', studentNo: '01', order: 0 },
    });
    const learnerStuA = await db.learner.create({
        data: {
            id: `${options.prefix}-learner-stu-a`,
            userId: user.id,
            kind: 'student',
            name: stuA.name,
            gradingStudentId: stuA.id,
            order: 0,
        },
    });
    const learnerStuB = await db.learner.create({
        data: {
            id: `${options.prefix}-learner-stu-b`,
            userId: user.id,
            kind: 'student',
            name: stuB.name,
            gradingStudentId: stuB.id,
            order: 1,
        },
    });

    return {
        user: { id: user.id, email: user.email, name: user.name ?? options.name },
        session: {
            user: { id: user.id, email: user.email, name: user.name ?? options.name, role: 'user' },
            expires: '2099-01-01',
        },
        notebook: { id: notebook.id, name: notebook.name },
        selfLearner: { id: selfLearner.id },
        children: {
            first: { id: childFirst.id, name: childFirst.name },
            second: { id: childSecond.id, name: childSecond.name },
        },
        classes: {
            classA: { id: classA.id, name: classA.name },
            classB: { id: classB.id, name: classB.name },
        },
        sameNameStudents: {
            inClassA: { gradingStudentId: stuA.id, learnerId: learnerStuA.id, name: '张三' },
            inClassB: { gradingStudentId: stuB.id, learnerId: learnerStuB.id, name: '张三' },
        },
    };
}

/**
 * OPT-21 双租户测试工具：自动创建 Alice 与 Bob 两个账户、各两个孩子（含同名孩子“小明”）及跨班同名花名册学生（“张三”）。
 */
export async function withTwoTenants<T>(
    db: PrismaClient,
    run: (ctx: TwoTenantsContext) => Promise<T>,
): Promise<T> {
    await db.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    const alice = await seedTenant(db, {
        prefix: 'alice',
        email: 'alice-tenant@example.com',
        name: 'Alice',
        childNames: ['小明', '小红'],
    });
    const bob = await seedTenant(db, {
        prefix: 'bob',
        email: 'bob-tenant@example.com',
        name: 'Bob',
        childNames: ['小明', '小刚'],
    });
    return run({ alice, bob });
}

/** 断言跨作用域/跨账户访问被拒绝并返回 404 */
export function expectCrossScopeNotFound(response: Response): void {
    expect(response.status).toBe(404);
}
