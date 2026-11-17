// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as { user: { id: string; email: string; role: string } } | null,
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET as getPersona, POST as postPersona, PATCH as patchPersona } from '@/app/api/persona/route';
import { GET as getLearners, POST as postLearners } from '@/app/api/learners/route';
import { DELETE as deleteLearner, PATCH as patchLearner } from '@/app/api/learners/[id]/route';
import { defaultPreselect, parsePersonas } from '@/lib/personas';
import { deleteChildLearner } from '@/lib/learners';

const REPO = resolve('.');
const PRISMA_BIN = resolve('node_modules/prisma/build/index.js');
const dir = mkdtempSync(join(tmpdir(), 'persona-'));
const dbPath = join(dir, 'test.db');
const url = `file:${dbPath}`;

execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', join(REPO, 'prisma/schema.prisma')], {
    env: { ...process.env, DATABASE_URL: url },
    cwd: REPO,
    stdio: 'pipe',
});

const db = new PrismaClient({ datasources: { db: { url } } });
mocks.prisma = db;

const sessionOf = (email: string, id: string) => ({ user: { id, email, role: 'user' } });

afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
});

describe('persona confirmation and child learners', () => {
    beforeEach(async () => {
        mocks.session = null;
        await db.errorItem.deleteMany();
        await db.learner.deleteMany();
        await db.gradingStudent.deleteMany();
        await db.gradingClass.deleteMany();
        await db.subject.deleteMany();
        await db.user.deleteMany();
    });

    it('existing users start unconfirmed; teacher is only preselected when a class exists', async () => {
        const selfUser = await db.user.create({
            data: { id: 'u-self', email: 'self@example.com', password: 'x', name: '自学用户' },
        });
        expect(selfUser.personas).toBe('[]');
        expect(selfUser.activePersona).toBeNull();
        expect(selfUser.personasConfirmedAt).toBeNull();
        expect(defaultPreselect(false)).toBe('self');

        const teacher = await db.user.create({
            data: { id: 'u-teacher', email: 'teacher@example.com', password: 'x', name: '老师' },
        });
        await db.gradingClass.create({ data: { id: 'c1', userId: teacher.id, name: '一班' } });
        expect(defaultPreselect(true)).toBe('teacher');

        mocks.session = sessionOf(selfUser.email, selfUser.id);
        const res = await getPersona();
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.confirmed).toBe(false);
        expect(data.suggestedPreselect).toBe('self');
        expect(data.personas).toEqual([]);

        mocks.session = sessionOf(teacher.email, teacher.id);
        const teacherData = await (await getPersona()).json();
        expect(teacherData.suggestedPreselect).toBe('teacher');
        expect(teacherData.confirmed).toBe(false);
    });

    it('confirming personas is explicit and does not happen on GET', async () => {
        const user = await db.user.create({
            data: { id: 'u-1', email: 'u1@example.com', password: 'x' },
        });
        mocks.session = sessionOf(user.email, user.id);
        await getPersona();
        const still = await db.user.findUnique({ where: { id: user.id } });
        expect(still?.personasConfirmedAt).toBeNull();

        const response = await postPersona(new Request('http://localhost/api/persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personas: ['teacher', 'self'], confirm: true }),
        }));
        const data = await response.json();
        expect(response.status).toBe(200);
        expect(data.confirmed).toBe(true);
        expect(data.personas).toEqual(['teacher', 'self']);
        expect(data.activePersona).toBe('self');

        const saved = await db.user.findUnique({ where: { id: user.id } });
        expect(parsePersonas(saved?.personas)).toEqual(['teacher', 'self']);
        expect(saved?.personasConfirmedAt).toBeTruthy();
    });

    it('two personas can be selected and saved together', async () => {
        const user = await db.user.create({
            data: { id: 'u-multi', email: 'multi@example.com', password: 'x' },
        });
        mocks.session = sessionOf(user.email, user.id);
        const response = await postPersona(new Request('http://localhost/api/persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personas: ['teacher', 'parent'], confirm: true }),
        }));
        const data = await response.json();
        expect(response.status).toBe(200);
        expect(data.personas).toEqual(['teacher', 'parent']);
        expect(['teacher', 'parent']).toContain(data.activePersona);
        const saved = await db.user.findUnique({ where: { id: user.id } });
        expect(parsePersonas(saved?.personas)).toEqual(['teacher', 'parent']);
    });

    it('parents can manage at most 3 children; deleting a child keeps questions unless explicitly confirmed', async () => {
        const user = await db.user.create({
            data: {
                id: 'p-1',
                email: 'parent@example.com',
                password: 'x',
                personas: '["parent"]',
                activePersona: 'parent',
                personasConfirmedAt: new Date(),
            },
        });
        const subject = await db.subject.create({
            data: { id: 's-1', name: '数学', userId: user.id },
        });
        mocks.session = sessionOf(user.email, user.id);

        const created = [];
        for (const name of ['小明', '小红', '小刚']) {
            const res = await postLearners(new Request('http://localhost/api/learners', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            }));
            expect(res.status).toBe(201);
            created.push(await res.json());
        }
        const fourth = await postLearners(new Request('http://localhost/api/learners', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '小四' }),
        }));
        expect(fourth.status).toBe(400);

        const childId = created[0].id as string;
        await db.errorItem.create({
            data: {
                id: 'item-1',
                userId: user.id,
                subjectId: subject.id,
                learnerId: childId,
                originalImageUrl: '',
                questionText: '保留这题',
            },
        });

        const denied = await deleteLearner(new Request('http://localhost/api/learners/' + childId, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteQuestions: true }),
        }), { params: Promise.resolve({ id: childId }) });
        expect(denied.status).toBe(400);
        expect(await db.errorItem.count()).toBe(1);

        const kept = await deleteLearner(new Request('http://localhost/api/learners/' + childId, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteQuestions: false }),
        }), { params: Promise.resolve({ id: childId }) });
        expect(kept.status).toBe(200);
        expect(await kept.json()).toMatchObject({ ok: true, archived: true, deletedQuestions: 0 });
        const item = await db.errorItem.findUnique({ where: { id: 'item-1' } });
        expect(item).toBeTruthy();
        // 默认软归档保留原孩子的 learnerId，不再改为 null 混入本人题库
        expect(item?.learnerId).toBe(childId);
        const archived = await db.learner.findUnique({ where: { id: childId } });
        expect(archived?.archivedAt).not.toBeNull();
        const activeList = await getLearners().then((r) => r.json());
        expect(activeList.children.some((c: { id: string }) => c.id === childId)).toBe(false);
        // 归档后未归档数量降至 2，可新增第 3 个活跃孩子
        const fifth = await postLearners(new Request('http://localhost/api/learners', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '小五' }),
        }));
        expect(fifth.status).toBe(201);

        const otherId = created[1].id as string;
        await db.errorItem.create({
            data: {
                id: 'item-2',
                userId: user.id,
                subjectId: subject.id,
                learnerId: otherId,
                originalImageUrl: '',
                questionText: '删除这题',
            },
        });
        const wiped = await deleteLearner(new Request('http://localhost/api/learners/' + otherId, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteQuestions: true, confirmDeleteQuestions: true }),
        }), { params: Promise.resolve({ id: otherId }) });
        expect(wiped.status).toBe(200);
        expect(await db.errorItem.findUnique({ where: { id: 'item-2' } })).toBeNull();
        expect(await db.errorItem.findUnique({ where: { id: 'item-1' } })).toBeTruthy();
    });

    it('can switch the active persona among confirmed ones only', async () => {
        const user = await db.user.create({
            data: {
                id: 'sw-1',
                email: 'sw@example.com',
                password: 'x',
                personas: '["teacher","parent","self"]',
                activePersona: 'self',
                personasConfirmedAt: new Date(),
            },
        });
        mocks.session = sessionOf(user.email, user.id);
        const ok = await patchPersona(new Request('http://localhost/api/persona', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activePersona: 'teacher' }),
        }));
        expect(ok.status).toBe(200);
        expect((await ok.json()).activePersona).toBe('teacher');

        const bad = await patchPersona(new Request('http://localhost/api/persona', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activePersona: 'admin' }),
        }));
        expect(bad.status).toBe(400);
    });

    it('rename uses the child update helper', async () => {
        const user = await db.user.create({
            data: {
                id: 'rn-1',
                email: 'rn@example.com',
                password: 'x',
                personas: '["parent"]',
                activePersona: 'parent',
                personasConfirmedAt: new Date(),
            },
        });
        mocks.session = sessionOf(user.email, user.id);
        const created = await postLearners(new Request('http://localhost/api/learners', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '旧名' }),
        }));
        const { id } = await created.json();
        const renamed = await patchLearner(new Request('http://localhost/api/learners/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '新名' }),
        }), { params: Promise.resolve({ id }) });
        expect(renamed.status).toBe(200);
        expect((await renamed.json()).name).toBe('新名');
        expect(await getLearners().then((r) => r.json())).toMatchObject({
            children: [expect.objectContaining({ name: '新名', itemCount: 0 })],
        });
        await expect(deleteChildLearner(db, user.id, 'missing')).rejects.toThrow('LEARNER_NOT_FOUND');
    });
});
