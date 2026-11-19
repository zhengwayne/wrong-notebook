const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

const REPO_ROOT = path.resolve(__dirname, '..');

async function loadLegacyAdminPasswordHash() {
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'src/lib/legacy-admin-password-hash.mjs')).href);
    return mod.legacyAdminPasswordHash;
}

/** 快照易被 next dev 改写的工作区文件，退出时原样恢复，避免 E2E 弄脏工作树 */
function snapshotTrackedFiles(relativePaths) {
    return relativePaths.map((rel) => {
        const abs = path.join(REPO_ROOT, rel);
        return {
            abs,
            existed: existsSync(abs),
            content: existsSync(abs) ? readFileSync(abs) : null,
        };
    });
}

function restoreTrackedFiles(snapshots) {
    for (const snap of snapshots) {
        try {
            if (snap.existed && snap.content !== null) {
                if (!existsSync(snap.abs) || !readFileSync(snap.abs).equals(snap.content)) {
                    writeFileSync(snap.abs, snap.content);
                }
            } else if (!snap.existed && existsSync(snap.abs)) {
                rmSync(snap.abs, { force: true });
            }
        } catch {
            // 退出阶段尽力还原
        }
    }
}

/** 每次启动使用新的配置目录和数据库，测试可安全地执行全站重置。 */
async function prepareFixture(directory) {
    const databaseUrl = `file:${path.join(directory, 'e2e.db').split(path.sep).join('/')}`;
    const env = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CONFIG_DIR: directory,
        NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
        ALLOW_REGISTRATION: 'true',
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: '',
        DAILY_SNAPSHOT_ENABLED: 'false',
    };
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env, stdio: 'inherit' });
    const legacyHash = await loadLegacyAdminPasswordHash();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
        const users = [
            { name: 'Admin', email: 'admin@localhost', passwordHash: await hash(process.env.E2E_ADMIN_PASSWORD || 'e2e-admin-pass', 10) },
            // 复用旧版通用口令哈希而非在脚本中硬编码明文密码
            { name: 'Setup Admin', email: 'setup-admin@localhost', passwordHash: legacyHash },
        ];
        for (const { name, email, passwordHash } of users) {
            await prisma.user.create({ data: {
                name, email, password: passwordHash, role: 'admin', isActive: true,
                educationStage: 'junior_high', enrollmentYear: 2025,
                personas: JSON.stringify(['self']), activePersona: 'self', personasConfirmedAt: new Date(),
            } });
        }
    } finally {
        await prisma.$disconnect();
    }
    writeFileSync(path.join(directory, 'app-config.json'), JSON.stringify({ setupCompletedAt: new Date().toISOString() }));
    return env;
}

async function main() {
    const address = new URL(process.env.NEXTAUTH_URL);
    const directory = mkdtempSync(path.join(tmpdir(), 'wrong-notebook-e2e-'));
    const useLocalDistDir = !process.env.CI;
    const trackedSnapshots = useLocalDistDir ? snapshotTrackedFiles(['tsconfig.json', 'next-env.d.ts']) : [];
    let server;
    let stopping = false;
    const stop = () => {
        stopping = true;
        if (!server) return;
        if (process.platform !== 'win32' && server.pid) {
            try {
                process.kill(-server.pid, 'SIGTERM');
                return;
            } catch {
                // 进程组已退出时回退单进程终止
            }
        }
        server.kill('SIGTERM');
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        const env = await prepareFixture(directory);
        if (stopping) return;
        if (useLocalDistDir) env.NEXT_DIST_DIR = '.next-e2e';
        const args = [require.resolve('next/dist/bin/next'), process.env.CI ? 'start' : 'dev',
            '-H', address.hostname, '-p', address.port || '80'];
        server = spawn(process.execPath, args, {
            env,
            stdio: 'inherit',
            detached: process.platform !== 'win32',
        });
        process.exitCode = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 0 : 1)));
        });
    } finally {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        rmSync(directory, { recursive: true, force: true });
        if (useLocalDistDir) {
            rmSync(path.join(REPO_ROOT, '.next-e2e'), { recursive: true, force: true });
            restoreTrackedFiles(trackedSnapshots);
        }
    }
}

if (require.main === module) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { prepareFixture };
