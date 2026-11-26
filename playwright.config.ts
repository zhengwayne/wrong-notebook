import { defineConfig, devices } from '@playwright/test';

const address = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3100');
if (address.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(address.hostname)
    || address.pathname !== '/' || address.search || address.hash || address.username || address.password) {
    throw new Error('E2E_BASE_URL 必须是本机 HTTP 地址，例如 http://127.0.0.1:3101');
}
const baseURL = address.origin;

const AI_FLOW_SPECS = [
    '**/parent-paper-flow.spec.ts',
    '**/teacher-grading-flow.spec.ts',
    '**/teacher-folder-import.spec.ts',
    '**/ai-quota-and-settings.spec.ts',
];

const RESET_SPECS = [
    '**/backup-reset-restore.spec.ts',
];

const SERIAL_SPECS = [...AI_FLOW_SPECS, ...RESET_SPECS];

export default defineConfig({
    testDir: './e2e',
    // 各用例共享本轮测试的管理员和配置，顺序执行避免状态竞争。
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: [['html', { host: '0.0.0.0' }]],
    use: {
        baseURL,
        trace: 'on-first-retry',
    },
    webServer: {
        command: 'node scripts/start-e2e.js',
        url: baseURL,
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
        timeout: 120 * 1000,
        env: { NEXTAUTH_URL: baseURL },
    },
    projects: [
        {
            name: 'chromium',
            testIgnore: SERIAL_SPECS,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'chromium-serial',
            testMatch: AI_FLOW_SPECS,
            dependencies: ['chromium'],
            fullyParallel: false,
            workers: 1,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'chromium-reset',
            testMatch: RESET_SPECS,
            dependencies: ['chromium-serial'],
            fullyParallel: false,
            workers: 1,
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
