#!/usr/bin/env node
/**
 * 只读审计 SQLite 数据库中 ErrorItem / PracticeRecord 的 learnerId 悬空外键（孤儿记录）。
 * 为避免直接触碰运行中或被锁定的数据库文件，会将 .db / -wal / -shm 拷贝到系统临时目录后再查询。
 *
 * 退出码：
 *   0 - 零孤儿记录
 *   2 - 发现至少一条孤儿 learnerId 记录
 *   1 - 参数错误或执行失败
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function parseSqlitePath(databaseUrl) {
    if (!databaseUrl || !databaseUrl.startsWith('file:')) {
        return null;
    }
    const rawPath = databaseUrl.slice('file:'.length).split('?')[0];
    if (!rawPath) return null;
    if (path.isAbsolute(rawPath)) return rawPath;
    const fromPrisma = path.resolve(process.cwd(), 'prisma', rawPath);
    if (fs.existsSync(fromPrisma)) return fromPrisma;
    return path.resolve(process.cwd(), rawPath);
}

function resolveTargetDbPath(dbPathArg) {
    if (dbPathArg) {
        return path.resolve(process.cwd(), dbPathArg);
    }
    const fromEnv = parseSqlitePath(process.env.DATABASE_URL);
    if (fromEnv) return fromEnv;
    return path.resolve(process.cwd(), 'prisma', 'dev.db');
}

function toSqliteUrl(filePath) {
    const normalized = filePath.split(path.sep).join('/');
    return `file:${normalized}?connection_limit=1`;
}

function parseCliArgs(argv) {
    let dbPath;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--db' && argv[i + 1]) {
            dbPath = argv[++i];
        } else if (arg.startsWith('--db=')) {
            dbPath = arg.slice('--db='.length);
        }
    }
    return { dbPath };
}

/**
 * 在临时只读快照副本上审计学习者外键孤儿数据。
 */
export async function auditLearnerForeignKeys({ dbPath } = {}) {
    const targetPath = resolveTargetDbPath(dbPath);
    if (!fs.existsSync(targetPath)) {
        throw new Error(`找不到目标 SQLite 数据库文件: ${targetPath}`);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learner-fk-audit-'));
    const snapshotDb = path.join(tmpDir, 'snapshot.db');

    fs.copyFileSync(targetPath, snapshotDb);
    for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${targetPath}${suffix}`;
        if (fs.existsSync(sidecar)) {
            fs.copyFileSync(sidecar, `${snapshotDb}${suffix}`);
        }
    }

    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient({
        datasources: { db: { url: toSqliteUrl(snapshotDb) } },
    });

    try {
        const [{ count: userCount }] = await client.$queryRawUnsafe('SELECT COUNT(*) AS count FROM "User";');
        const [{ count: learnerCount }] = await client.$queryRawUnsafe('SELECT COUNT(*) AS count FROM "Learner";');
        const [{ count: errorItemCount }] = await client.$queryRawUnsafe('SELECT COUNT(*) AS count FROM "ErrorItem";');
        const [{ count: practiceRecordCount }] = await client.$queryRawUnsafe('SELECT COUNT(*) AS count FROM "PracticeRecord";');

        const orphanErrorItems = await client.$queryRawUnsafe(`
            SELECT "id", "userId", "learnerId"
            FROM "ErrorItem"
            WHERE "learnerId" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "Learner" l WHERE l."id" = "ErrorItem"."learnerId"
              )
            ORDER BY "createdAt" ASC, "id" ASC;
        `);

        const orphanPracticeRecords = await client.$queryRawUnsafe(`
            SELECT "id", "userId", "learnerId"
            FROM "PracticeRecord"
            WHERE "learnerId" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "Learner" l WHERE l."id" = "PracticeRecord"."learnerId"
              )
            ORDER BY "createdAt" ASC, "id" ASC;
        `);

        const counts = {
            users: Number(userCount ?? 0),
            learners: Number(learnerCount ?? 0),
            errorItems: Number(errorItemCount ?? 0),
            practiceRecords: Number(practiceRecordCount ?? 0),
        };

        return {
            counts,
            orphanErrorItems: orphanErrorItems.map((row) => ({
                id: String(row.id),
                userId: String(row.userId),
                learnerId: String(row.learnerId),
            })),
            orphanPracticeRecords: orphanPracticeRecords.map((row) => ({
                id: String(row.id),
                userId: String(row.userId),
                learnerId: String(row.learnerId),
            })),
            totalOrphans: orphanErrorItems.length + orphanPracticeRecords.length,
        };
    } finally {
        await client.$disconnect();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    (async () => {
        try {
            const { dbPath } = parseCliArgs(process.argv.slice(2));
            const report = await auditLearnerForeignKeys({ dbPath });
            console.log(JSON.stringify(report, null, 2));
            process.exit(report.totalOrphans > 0 ? 2 : 0);
        } catch (error) {
            console.error('[audit-learner-foreign-keys] 审计失败:', error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    })();
}
