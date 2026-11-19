const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

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
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
        for (const [name, email, password] of [
            ['Admin', 'admin@localhost', process.env.E2E_ADMIN_PASSWORD || 'e2e-admin-pass'],
            ['Setup Admin', 'setup-admin@localhost', '123456'],
        ]) {
            await prisma.user.create({ data: {
                name, email, password: await hash(password, 10), role: 'admin', isActive: true,
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
    let server;
    let stopping = false;
    const stop = () => {
        stopping = true;
        server?.kill('SIGTERM');
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        const env = await prepareFixture(directory);
        if (stopping) return;
        if (!process.env.CI) env.NEXT_DIST_DIR = '.next-e2e';
        const args = [require.resolve('next/dist/bin/next'), process.env.CI ? 'start' : 'dev',
            '-H', address.hostname, '-p', address.port || '80'];
        server = spawn(process.execPath, args, { env, stdio: 'inherit' });
        process.exitCode = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 0 : 1)));
        });
    } finally {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        rmSync(directory, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { prepareFixture };
