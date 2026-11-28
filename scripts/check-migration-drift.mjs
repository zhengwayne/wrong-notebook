#!/usr/bin/env node
/**
 * 检查 prisma/migrations 与 prisma/schema.prisma 是否存在未生成迁移的漂移。
 * 退出码 0 表示完全一致，2 表示存在漂移，1 表示执行出错。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 执行一次独立临时影子库的 prisma migrate diff --exit-code 检查。
 */
export function checkMigrationDrift({
    repoRoot = process.cwd(),
    schemaPath = path.join(repoRoot, 'prisma', 'schema.prisma'),
    migrationsDir = path.join(repoRoot, 'prisma', 'migrations'),
    stdio = 'inherit',
} = {}) {
    const prismaBin = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-drift-'));
    const shadowDb = path.join(tmpDir, 'shadow.db');
    const shadowUrl = `file:${shadowDb.split(path.sep).join('/')}`;

    try {
        const result = spawnSync(
            process.execPath,
            [
                prismaBin,
                'migrate',
                'diff',
                '--from-migrations',
                migrationsDir,
                '--to-schema-datamodel',
                schemaPath,
                '--shadow-database-url',
                shadowUrl,
                '--exit-code',
            ],
            {
                cwd: repoRoot,
                stdio,
                windowsHide: true,
            },
        );
        if (result.error) {
            throw result.error;
        }
        return result.status ?? 1;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const status = checkMigrationDrift();
    if (status === 0) {
        console.log('[migration-drift] 数据库迁移与 schema.prisma 完全一致。');
    } else if (status === 2) {
        console.error('[migration-drift] 检测到 schema.prisma 与 prisma/migrations 存在差异，请补充正式迁移后再提交。');
    } else {
        console.error(`[migration-drift] 迁移漂移检查执行失败（退出码 ${status}）。`);
    }
    process.exit(status);
}
