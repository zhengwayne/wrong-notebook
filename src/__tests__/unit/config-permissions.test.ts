/**
 * 验证真实文件系统下 app-config.json 的权限（0o600）与原子替换行为
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config 真实文件权限与原子写入', () => {
    const originalConfigDir = process.env.CONFIG_DIR;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-cfg-'));
        process.env.CONFIG_DIR = tmpDir;
        vi.resetModules();
    });

    afterEach(() => {
        if (originalConfigDir === undefined) {
            delete process.env.CONFIG_DIR;
        } else {
            process.env.CONFIG_DIR = originalConfigDir;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('新建或更新 app-config.json 时权限应为 0o600 且不残留临时文件', async () => {
        const configPath = path.join(tmpDir, 'app-config.json');
        fs.writeFileSync(configPath, JSON.stringify({ aiProvider: 'openai' }), { mode: 0o644 });

        const { updateAppConfig } = await import('@/lib/config');
        const updated = updateAppConfig({ aiProvider: 'gemini' });

        expect(updated.aiProvider).toBe('gemini');
        expect(fs.readdirSync(tmpDir)).toEqual(['app-config.json']);

        if (process.platform !== 'win32') {
            const mode = fs.statSync(configPath).mode & 0o777;
            expect(mode).toBe(0o600);
        }
    });

    it('连续更新配置时在同步读-改-写中保留已落盘的其他字段', async () => {
        const { updateAppConfig, getAppConfig } = await import('@/lib/config');
        updateAppConfig({ allowRegistration: true });
        updateAppConfig({ aiDailyLimit: 25 });

        const finalConfig = getAppConfig();
        expect(finalConfig.allowRegistration).toBe(true);
        expect(finalConfig.aiDailyLimit).toBe(25);
    });
});
