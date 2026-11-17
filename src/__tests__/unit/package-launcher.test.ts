/**
 * 安装包启动器单元测试
 * 覆盖命令行参数解析、SQLite 地址转换、会话密钥、迁移前自动备份与 WAL checkpoint
 */
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const launcher = require('../../../packaging/runtime/launcher.js') as {
    parseArgs: (argv: string[]) => { port?: string; host?: string; dataDir?: string };
    sqliteUrl: (file: string) => string;
    sqliteDatasourceUrl: (file: string) => string;
    ensureSecret: (dataDir: string) => string;
    backupBeforeMigrate: (opts: {
        dbFile: string;
        dataDir: string;
        version: string;
        env?: NodeJS.ProcessEnv;
        checkpointRunner?: (dbFile: string, env: NodeJS.ProcessEnv) => void;
    }) => string | null;
    prepare: (opts?: {
        dataDir?: string;
        _runPrisma?: (args: string[], env: NodeJS.ProcessEnv) => boolean;
        _checkpointRunner?: (dbFile: string, env: NodeJS.ProcessEnv) => void;
    }) => { dataDir: string; dbFile: string; env: NodeJS.ProcessEnv; version: string; backupPath: string | null };
};

const REPO_ROOT = path.resolve('.');
const PRISMA_BIN = path.resolve('node_modules/prisma/build/index.js');

function deploySchema(dbFile: string): string {
    const url = `file:${dbFile.split(path.sep).join('/')}`;
    execFileSync(process.execPath, [PRISMA_BIN, 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: url },
        cwd: REPO_ROOT,
        stdio: 'pipe',
    });
    return url;
}

describe('package launcher', () => {
    it('解析长短参数和等号写法', () => {
        expect(launcher.parseArgs(['--port', '8080', '-H', '127.0.0.1', '--data-dir=/srv/data'])).toEqual({
            port: '8080',
            host: '127.0.0.1',
            dataDir: '/srv/data',
        });
        expect(launcher.parseArgs(['-p=3001', '-d', 'data'])).toEqual({ port: '3001', dataDir: 'data' });
    });

    it('忽略未知参数', () => {
        expect(launcher.parseArgs(['--verbose', 'start'])).toEqual({});
    });

    it('SQLite 地址使用正斜杠且 Datasource 注入 connection_limit=1', () => {
        const file = ['data', 'wrong-notebook.db'].join(path.sep);
        expect(launcher.sqliteUrl(file)).toBe('file:data/wrong-notebook.db');
        expect(launcher.sqliteDatasourceUrl(file)).toBe('file:data/wrong-notebook.db?connection_limit=1');
    });

    it('会话密钥首次生成后保持不变，空文件会被重新生成', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-secret-'));
        try {
            const first = launcher.ensureSecret(dir);
            expect(first).toMatch(/^[A-Za-z0-9+/]{43}=$/);
            expect(launcher.ensureSecret(dir)).toBe(first);

            fs.writeFileSync(path.join(dir, '.nextauth_secret'), '');
            const regenerated = launcher.ensureSecret(dir);
            expect(regenerated).not.toBe('');
            expect(fs.readFileSync(path.join(dir, '.nextauth_secret'), 'utf8')).toBe(regenerated);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('迁移前对非空 WAL 执行 checkpoint 并生成包含最新事务的单文件备份', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-wal-backup-'));
        const dbFile = path.join(dir, 'wrong-notebook.db');
        try {
            const url = deploySchema(dbFile);
            const client = new PrismaClient({ datasources: { db: { url } } });
            await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
            // 显式关闭自动 checkpoint，确保写入保留在 -wal 中
            await client.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
            await client.user.create({
                data: { email: 'wal-only@example.com', password: 'hash', name: 'WAL用户' },
            });
            await client.$disconnect();

            // 在无额外写者干扰下先确认如果存在 -wal 或通过子进程 checkpoint 均能正常把数据刷入单文件备份
            const walPath = `${dbFile}-wal`;
            if (!fs.existsSync(walPath) || fs.statSync(walPath).size === 0) {
                // Prisma $disconnect 可能已触发一次 checkpoint；再插入一条并通过未关闭前保持 -wal 的连接验证
                const holdClient = new PrismaClient({ datasources: { db: { url } } });
                await holdClient.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
                await holdClient.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
                await holdClient.user.create({
                    data: { email: 'wal-hold@example.com', password: 'hash', name: 'WAL留存用户' },
                });
                expect(fs.existsSync(walPath)).toBe(true);
                expect(fs.statSync(walPath).size).toBeGreaterThan(0);
                await holdClient.$disconnect();
            }

            // 模拟写入后 -wal 仍非空（例如异常退出留下的 -wal）
            const writer = new PrismaClient({ datasources: { db: { url } } });
            await writer.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
            await writer.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
            await writer.user.create({
                data: { email: 'wal-live@example.com', password: 'hash', name: '活跃WAL' },
            });
            const backupPath = launcher.backupBeforeMigrate({
                dbFile,
                dataDir: dir,
                version: '2026.11.18',
            });
            await writer.$disconnect();

            expect(backupPath).toBeTruthy();
            expect(backupPath!.endsWith('.db')).toBe(true);
            expect(fs.existsSync(backupPath!)).toBe(true);

            // 使用独立 PrismaClient 验证备份库包含刚才在 -wal 中的记录
            const verifyUrl = launcher.sqliteDatasourceUrl(backupPath!);
            const verifyClient = new PrismaClient({ datasources: { db: { url: verifyUrl } } });
            try {
                const found = await verifyClient.user.findUnique({ where: { email: 'wal-live@example.com' } });
                expect(found?.name).toBe('活跃WAL');
            } finally {
                await verifyClient.$disconnect();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 20000);

    it('无法清空 -wal 时自动备份 .db/-wal/-shm 三件套并生成 RECOVERY.txt，且最多保留 3 份', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-wal-fallback-'));
        const dbFile = path.join(dir, 'wrong-notebook.db');
        try {
            fs.writeFileSync(dbFile, 'main-db');
            fs.writeFileSync(`${dbFile}-wal`, 'wal-payload');
            fs.writeFileSync(`${dbFile}-shm`, 'shm-payload');

            const backups: string[] = [];
            for (let i = 0; i < 5; i++) {
                const p = launcher.backupBeforeMigrate({
                    dbFile,
                    dataDir: dir,
                    version: `1.0.${i}`,
                    checkpointRunner: () => {
                        throw new Error('simulated busy');
                    },
                });
                backups.push(p!);
            }

            const entries = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('pre-migrate-'));
            expect(entries).toHaveLength(3);
            expect(entries).toEqual(backups.slice(-3).map((p) => path.basename(p)));

            const latestDir = backups[4];
            expect(fs.statSync(latestDir).isDirectory()).toBe(true);
            expect(fs.readFileSync(path.join(latestDir, 'wrong-notebook.db'), 'utf8')).toBe('main-db');
            expect(fs.readFileSync(path.join(latestDir, 'wrong-notebook.db-wal'), 'utf8')).toBe('wal-payload');
            expect(fs.readFileSync(path.join(latestDir, 'wrong-notebook.db-shm'), 'utf8')).toBe('shm-payload');
            expect(fs.readFileSync(path.join(latestDir, 'RECOVERY.txt'), 'utf8')).toContain('三件套');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prepare 在迁移失败时输出备份恢复指引并拒绝启动，首次无库时不触发备份', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-prepare-'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        try {
            // 首次无数据库：不备份
            const first = launcher.prepare({
                dataDir: dir,
                _runPrisma: () => true,
            });
            expect(first.backupPath).toBeNull();
            expect(fs.existsSync(path.join(dir, '.app_version'))).toBe(true);

            // 模拟已有非空数据库且迁移失败
            fs.writeFileSync(first.dbFile, 'existing-db-bytes');
            expect(() => launcher.prepare({
                dataDir: dir,
                _runPrisma: () => false,
            })).toThrow(/数据库迁移失败，已停止启动/);
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pre-migrate-'));
        } finally {
            errorSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
