import { defineConfig, devices } from '@playwright/test';

// 本机 3000 端口被占用时，可用 E2E_BASE_URL 指向另行启动的开发服务器
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const port = new URL(baseURL).port || '3000';

const AI_FLOW_SPECS = [
    '**/parent-paper-flow.spec.ts',
    '**/teacher-grading-flow.spec.ts',
];

const RESET_SPECS = [
    '**/backup-reset-restore.spec.ts',
];

const SERIAL_SPECS = [...AI_FLOW_SPECS, ...RESET_SPECS];

export default defineConfig({
    testDir: './e2e',
    // 各用例共享 admin@localhost 与 config/app-config.json，统一顺序执行避免跨进程状态竞争
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
        command: process.env.CI ? `npx next start -p ${port}` : `npx next dev -H 0.0.0.0 -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
        // 注册默认关闭，注册流程用例需要开启；显式对齐 NEXTAUTH_URL
        env: {
            ...process.env as Record<string, string>,
            ALLOW_REGISTRATION: 'true',
            NEXTAUTH_URL: baseURL,
        },
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
