/**
 * Prisma 迁移漂移检查脚本单元测试
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkMigrationDrift } from '../../../scripts/check-migration-drift.mjs';

describe('checkMigrationDrift', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-unit-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('schema 与 migrations 完全匹配时返回 0，漏建迁移时返回 2 拦截', () => {
        const prismaDir = path.join(tmpDir, 'prisma');
        const migrationsDir = path.join(prismaDir, 'migrations');
        const initDir = path.join(migrationsDir, '20260101000000_init');
        fs.mkdirSync(initDir, { recursive: true });

        const schemaPath = path.join(prismaDir, 'schema.prisma');
        fs.writeFileSync(
            schemaPath,
            [
                'datasource db {',
                '  provider = "sqlite"',
                '  url = env("DATABASE_URL")',
                '}',
                'model Note {',
                '  id String @id',
                '}',
                '',
            ].join('\n'),
        );
        fs.writeFileSync(path.join(migrationsDir, 'migration_lock.toml'), 'provider = "sqlite"\n');
        fs.writeFileSync(
            path.join(initDir, 'migration.sql'),
            'CREATE TABLE "Note" (\n    "id" TEXT NOT NULL PRIMARY KEY\n);\n',
        );

        const cleanCode = checkMigrationDrift({
            repoRoot: tmpDir,
            schemaPath,
            migrationsDir,
            stdio: 'pipe',
        });
        expect(cleanCode).toBe(0);

        // 增加字段但未建迁移
        fs.writeFileSync(
            schemaPath,
            [
                'datasource db {',
                '  provider = "sqlite"',
                '  url = env("DATABASE_URL")',
                '}',
                'model Note {',
                '  id String @id',
                '  extra TEXT?',
                '}',
                '',
            ].join('\n').replace('extra TEXT?', 'extra String?'),
        );

        const driftCode = checkMigrationDrift({
            repoRoot: tmpDir,
            schemaPath,
            migrationsDir,
            stdio: 'pipe',
        });
        expect(driftCode).toBe(2);
    }, 20000);
});
