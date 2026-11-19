import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareFixture } from '../../../scripts/start-e2e.js';

describe('E2E 测试数据隔离', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('继承其他数据库与配置路径时，只在指定的临时目录迁移、创建账号与写入配置', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'e2e-isolation-test-'));
        try {
            const inherited = path.join(root, 'inherited');
            const fixture = path.join(root, 'fixture');
            mkdirSync(inherited);
            mkdirSync(fixture);
            const originalDb = path.join(inherited, 'development.db');
            const originalConfig = path.join(inherited, 'app-config.json');
            writeFileSync(originalDb, '数据库哨兵');
            writeFileSync(originalConfig, '{"marker":"配置哨兵"}');
            vi.stubEnv('DATABASE_URL', `file:${originalDb}`);
            vi.stubEnv('CONFIG_DIR', inherited);

            const env = await prepareFixture(fixture);
            const fixtureUrl = `file:${path.join(fixture, 'e2e.db').split(path.sep).join('/')}`;
            expect(env.DATABASE_URL).toBe(fixtureUrl);
            expect(env.CONFIG_DIR).toBe(fixture);
            expect(readFileSync(originalDb, 'utf8')).toBe('数据库哨兵');
            expect(readFileSync(originalConfig, 'utf8')).toBe('{"marker":"配置哨兵"}');
            expect(readdirSync(inherited).sort()).toEqual(['app-config.json', 'development.db']);
            expect(JSON.parse(readFileSync(path.join(fixture, 'app-config.json'), 'utf8')).setupCompletedAt).toBeTruthy();

            const db = new PrismaClient({ datasources: { db: { url: fixtureUrl } } });
            try {
                const users = await db.user.findMany({ select: { email: true }, orderBy: { email: 'asc' } });
                expect(users.map(user => user.email)).toEqual(['admin@localhost', 'setup-admin@localhost']);
            } finally {
                await db.$disconnect();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);

    it.each([undefined, 'true'])('CI=%s 时端口已被占用也禁止复用现有服务', async (ci) => {
        vi.stubEnv('CI', ci);
        vi.stubEnv('E2E_BASE_URL', 'http://127.0.0.1:3199');
        vi.resetModules();
        const { default: config } = await import('../../../playwright.config');
        const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
        expect(servers).toHaveLength(1);
        expect(servers[0]?.url).toBe(config.use?.baseURL);
        expect(servers[0]?.reuseExistingServer).toBe(false);
    });
});
