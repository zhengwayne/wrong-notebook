// @vitest-environment node
/**
 * OPT-08 学习者外键重建迁移集成测试：
 * - 在含 10,000 道错题、非空 WAL 与孤儿 learnerId 的旧版库上验证只读审计与迁移前备份
 * - 验证正式迁移 20261118020000_add_learner_foreign_keys 不丢失题目与标签关系、修复孤儿、通过 foreign_key_check
 * - 验证 PRAGMA foreign_keys = ON 下 Learner 删除触发 ON DELETE SET NULL
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLearnerForeignKeys as rawAuditLearnerForeignKeys } from '../../../scripts/audit-learner-foreign-keys.mjs';

interface AuditReport {
    counts: { users: number; learners: number; errorItems: number; practiceRecords: number };
    orphanErrorItems: Array<{ id: string; userId: string; learnerId: string }>;
    orphanPracticeRecords: Array<{ id: string; userId: string; learnerId: string }>;
    totalOrphans: number;
}

const auditLearnerForeignKeys = rawAuditLearnerForeignKeys as (opts?: { dbPath?: string }) => Promise<AuditReport>;

const require = createRequire(import.meta.url);
const launcher = require('../../../packaging/runtime/launcher.js') as {
    sqliteDatasourceUrl: (file: string) => string;
    backupBeforeMigrate: (opts: { dbFile: string; dataDir: string; version: string }) => string | null;
};

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');
const TARGET_MIGRATION = '20261118020000_add_learner_foreign_keys';

describe('learnerId foreign key migration (10k rows + WAL + orphan audit)', () => {
    const cleanups: string[] = [];

    afterEach(() => {
        while (cleanups.length > 0) {
            const dir = cleanups.pop()!;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('完成只读审计、WAL 备份与 1 万题重建迁移并激活 ON DELETE SET NULL 外键', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learner-fk-10k-'));
        cleanups.push(tmpDir);

        // 1. 构造“迁移前（排除 >= 20261118020000 之后迁移）”的旧版迁移集合
        const oldPrismaDir = path.join(tmpDir, 'old-prisma');
        const oldMigrationsDir = path.join(oldPrismaDir, 'migrations');
        fs.mkdirSync(oldMigrationsDir, { recursive: true });
        fs.copyFileSync(
            path.join(REPO_ROOT, 'prisma/migrations/migration_lock.toml'),
            path.join(oldMigrationsDir, 'migration_lock.toml'),
        );
        for (const entry of fs.readdirSync(path.join(REPO_ROOT, 'prisma/migrations')).sort()) {
            if (entry === 'migration_lock.toml') continue;
            if (entry >= TARGET_MIGRATION) continue;
            fs.cpSync(
                path.join(REPO_ROOT, 'prisma/migrations', entry),
                path.join(oldMigrationsDir, entry),
                { recursive: true },
            );
        }
        const oldSchemaPath = path.join(oldPrismaDir, 'schema.prisma');
        fs.writeFileSync(
            oldSchemaPath,
            'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n',
        );

        const dataDir = path.join(tmpDir, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const dbFile = path.join(dataDir, 'legacy.db');
        const dbUrl = launcher.sqliteDatasourceUrl(dbFile);

        execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', oldSchemaPath], {
            env: { ...process.env, DATABASE_URL: dbUrl },
            cwd: REPO_ROOT,
            stdio: 'pipe',
        });

        // 2. 注入 10,000 道错题 + 标签关联 + 孤儿 learnerId + 非空 -wal
        const setupClient = new PrismaClient({ datasources: { db: { url: dbUrl } } });
        try {
            await setupClient.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
            await setupClient.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');

            await setupClient.$executeRawUnsafe(`
                INSERT INTO "User" ("id", "email", "password", "name", "updatedAt")
                VALUES ('u1', 'fk-10k@example.com', 'hash', '测试家长', CURRENT_TIMESTAMP);
            `);
            await setupClient.$executeRawUnsafe(`
                INSERT INTO "Subject" ("id", "userId", "name", "stage", "subjectKey", "updatedAt")
                VALUES ('sub1', 'u1', '数学', 'junior_high', 'math', CURRENT_TIMESTAMP);
            `);
            await setupClient.$executeRawUnsafe(`
                INSERT INTO "Learner" ("id", "userId", "kind", "name", "order", "updatedAt")
                VALUES ('ln-keep', 'u1', 'child', '大宝', 0, CURRENT_TIMESTAMP),
                       ('ln-del', 'u1', 'child', '二宝', 1, CURRENT_TIMESTAMP);
            `);
            await setupClient.$executeRawUnsafe(`
                INSERT INTO "KnowledgeTag" ("id", "name", "subject", "isSystem", "order", "updatedAt")
                VALUES ('tag-1', '一次函数', 'math', 1, 1, CURRENT_TIMESTAMP);
            `);

            const TOTAL_ITEMS = 10000;
            const BATCH_SIZE = 500;
            for (let start = 0; start < TOTAL_ITEMS; start += BATCH_SIZE) {
                const values: string[] = [];
                for (let idx = start; idx < start + BATCH_SIZE; idx++) {
                    let learnerSql = 'NULL';
                    if (idx < 2) learnerSql = "'orphan-learner'";
                    else if (idx < 2000) learnerSql = "'ln-del'";
                    else if (idx < 6000) learnerSql = "'ln-keep'";
                    values.push(
                        `('ei-${idx}', 'u1', 'sub1', '', '题干 ${idx}', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ${learnerSql})`,
                    );
                }
                await setupClient.$executeRawUnsafe(
                    `INSERT INTO "ErrorItem" ("id", "userId", "subjectId", "originalImageUrl", "questionText", "masteryLevel", "hasFigure", "createdAt", "updatedAt", "learnerId") VALUES ${values.join(',')};`,
                );
            }

            // 建立 500 条标签多对多关联与 4 条练习（其中 2 条为孤儿 learnerId）
            const tagLinks: string[] = [];
            for (let i = 0; i < 500; i++) {
                tagLinks.push(`('ei-${i}', 'tag-1')`);
            }
            await setupClient.$executeRawUnsafe(
                `INSERT INTO "_ErrorItemToKnowledgeTag" ("A", "B") VALUES ${tagLinks.join(',')};`,
            );
            await setupClient.$executeRawUnsafe(`
                INSERT INTO "PracticeRecord" ("id", "userId", "errorItemId", "result", "isCorrect", "source", "learnerId", "createdAt") VALUES
                ('pr-orphan-1', 'u1', 'ei-0', 'wrong', 0, 'practice', 'orphan-learner', CURRENT_TIMESTAMP),
                ('pr-orphan-2', 'u1', NULL, 'correct', 1, 'practice', 'orphan-learner-2', CURRENT_TIMESTAMP),
                ('pr-del-1', 'u1', 'ei-10', 'wrong', 0, 'practice', 'ln-del', CURRENT_TIMESTAMP),
                ('pr-keep-1', 'u1', 'ei-3000', 'correct', 1, 'practice', 'ln-keep', CURRENT_TIMESTAMP);
            `);
        } finally {
            await setupClient.$disconnect();
        }

        // 确保断开前如已触发 checkpoint，则再开一次写连接留在 -wal 中以便验证审计与 WAL 备份
        const walWriter = new PrismaClient({ datasources: { db: { url: dbUrl } } });
        await walWriter.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
        await walWriter.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
        await walWriter.$executeRawUnsafe(`UPDATE "User" SET "name" = '在WAL中更新的名字' WHERE "id" = 'u1';`);
        const walPath = `${dbFile}-wal`;
        expect(fs.existsSync(walPath)).toBe(true);
        expect(fs.statSync(walPath).size).toBeGreaterThan(0);

        // 3. 在 -wal 非空时运行只读审计：准确检出 2+2 孤儿，且不改动原库
        const auditBefore = await auditLearnerForeignKeys({ dbPath: dbFile });
        expect(auditBefore.counts.errorItems).toBe(10000);
        expect(auditBefore.counts.practiceRecords).toBe(4);
        expect(auditBefore.totalOrphans).toBe(4);
        expect(auditBefore.orphanErrorItems.map((r) => r.id)).toEqual(['ei-0', 'ei-1']);
        expect(auditBefore.orphanPracticeRecords.map((r) => r.id)).toEqual(['pr-orphan-1', 'pr-orphan-2']);

        await walWriter.$disconnect();

        // 再次制造非空 -wal 后调用迁移前备份（无并发写者阻塞时应清空并生成完整单文件）
        const backupWriter = new PrismaClient({ datasources: { db: { url: dbUrl } } });
        await backupWriter.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
        await backupWriter.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
        await backupWriter.$executeRawUnsafe(`UPDATE "User" SET "name" = '备份前最终名字' WHERE "id" = 'u1';`);
        const backupPath = launcher.backupBeforeMigrate({ dbFile, dataDir, version: '2026.11.18' });
        await backupWriter.$disconnect();

        expect(backupPath).toBeTruthy();
        expect(fs.existsSync(backupPath!)).toBe(true);
        if (backupPath!.endsWith('.db')) {
            const verifyBackup = new PrismaClient({
                datasources: { db: { url: launcher.sqliteDatasourceUrl(backupPath!) } },
            });
            try {
                const userRow = await verifyBackup.user.findUnique({ where: { id: 'u1' }, select: { name: true } });
                expect(userRow?.name).toBe('备份前最终名字');
                expect(await verifyBackup.errorItem.count()).toBe(10000);
            } finally {
                await verifyBackup.$disconnect();
            }
        }

        // 4. 应用仓库完整 migrations（包含 20261118020000_add_learner_foreign_keys）
        const startedAt = Date.now();
        execFileSync(
            process.execPath,
            [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')],
            {
                env: { ...process.env, DATABASE_URL: dbUrl },
                cwd: REPO_ROOT,
                stdio: 'pipe',
            },
        );
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(15000);

        // 5. 验证迁移后数据完整性、外键检查与 ON DELETE SET NULL 级联行为
        const migrated = new PrismaClient({ datasources: { db: { url: dbUrl } } });
        try {
            expect(await migrated.errorItem.count()).toBe(10000);
            expect(await migrated.practiceRecord.count()).toBe(4);
            const [{ count: tagCount }] = await migrated.$queryRawUnsafe<Array<{ count: bigint }>>(
                'SELECT COUNT(*) AS count FROM "_ErrorItemToKnowledgeTag";',
            );
            expect(Number(tagCount)).toBe(500);

            const fkViolations = await migrated.$queryRawUnsafe<Array<unknown>>('PRAGMA foreign_key_check;');
            expect(fkViolations).toEqual([]);

            // 孤儿应被审计并安全置空
            const unlinkedItems = await migrated.errorItem.findMany({
                where: { id: { in: ['ei-0', 'ei-1'] } },
                select: { id: true, learnerId: true },
            });
            expect(unlinkedItems.every((row) => row.learnerId === null)).toBe(true);
            const unlinkedPractices = await migrated.practiceRecord.findMany({
                where: { id: { in: ['pr-orphan-1', 'pr-orphan-2'] } },
                select: { id: true, learnerId: true },
            });
            expect(unlinkedPractices.every((row) => row.learnerId === null)).toBe(true);

            const audits = await migrated.learnerBackfillAudit.findMany({
                where: { batchId: `migration:${TARGET_MIGRATION}` },
            });
            expect(audits).toHaveLength(4);

            // 验证开启 foreign_keys = ON 后，删除 ln-del 自动将关联 ErrorItem / PracticeRecord 的 learnerId 置 NULL
            await migrated.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
            await migrated.$executeRawUnsafe('DELETE FROM "Learner" WHERE "id" = \'ln-del\';');

            const detachedItem = await migrated.errorItem.findUnique({ where: { id: 'ei-10' }, select: { learnerId: true } });
            const detachedPr = await migrated.practiceRecord.findUnique({ where: { id: 'pr-del-1' }, select: { learnerId: true } });
            const keptItem = await migrated.errorItem.findUnique({ where: { id: 'ei-3000' }, select: { learnerId: true } });
            expect(detachedItem?.learnerId).toBeNull();
            expect(detachedPr?.learnerId).toBeNull();
            expect(keptItem?.learnerId).toBe('ln-keep');
        } finally {
            await migrated.$disconnect();
        }
    }, 60000);
});
