import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareSync } from 'bcryptjs';
import { expect, it } from 'vitest';
import { legacyAdminPasswordSample } from '../fixtures/legacy-admin';

it('飞牛安装回调拒绝旧口令，只保存新口令的哈希', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fnos-initial-admin-'));
    try {
        const script = path.join(dir, 'initial-admin.mjs');
        const output = path.join(dir, 'initial-admin.json');
        copyFileSync('packaging/fnos/app/initial-admin.mjs', script);
        copyFileSync('src/lib/legacy-admin-password-hash.mjs', path.join(dir, 'legacy-admin-password-hash.mjs'));
        const run = (password: string) => spawnSync(process.execPath, [script, process.cwd(), output], {
            env: { ...process.env, WN_ADMIN_EMAIL: 'installer@example.test', WN_ADMIN_PASSWORD: password },
            encoding: 'utf8',
        });
        const rejected = run(legacyAdminPasswordSample);
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain('旧版通用密码');
        expect(rejected.stderr.includes(legacyAdminPasswordSample)).toBe(false);
        expect(existsSync(output)).toBe(false);

        const password = randomBytes(6).toString('base64url');
        expect(run(password).status).toBe(0);
        const content = readFileSync(output, 'utf8');
        expect(content.includes(password)).toBe(false);
        expect(compareSync(password, JSON.parse(content).passwordHash)).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('飞牛安装向导规则禁止空格和旧版通用简单密码，且不写入明文字面量', () => {
    const raw = readFileSync('packaging/fnos/wizard/install', 'utf8');
    expect(raw.includes(legacyAdminPasswordSample)).toBe(false);
    const steps = JSON.parse(raw) as Array<{
        items: Array<{ field?: string; rules?: Array<{ pattern?: string; message?: string }> }>;
    }>;
    const passwordItem = steps.flatMap(step => step.items).find(item => item.field === 'wizard_admin_password');
    const patternRule = passwordItem?.rules?.find(rule => typeof rule.pattern === 'string');
    expect(patternRule?.message).toBe('不能包含空格，也不能使用旧版通用简单密码');
    const regex = new RegExp(patternRule!.pattern!);
    expect(regex.test(legacyAdminPasswordSample)).toBe(false);
    expect(regex.test('has space')).toBe(false);
    expect(regex.test('StrongPass1!')).toBe(true);
});

it.skipIf(process.platform === 'win32')('install_callback 失败时把错误摘要写入 install.log、stderr 和 TRIM_TEMP_LOGFILE', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fnos-callback-'));
    try {
        const appDir = path.join(dir, 'app');
        const dataDir = path.join(dir, 'data');
        const tempLog = path.join(dir, 'trim-temp.log');
        mkdirSync(path.join(appDir, 'server'), { recursive: true });
        copyFileSync('packaging/fnos/app/initial-admin.mjs', path.join(appDir, 'initial-admin.mjs'));
        copyFileSync('src/lib/legacy-admin-password-hash.mjs', path.join(appDir, 'legacy-admin-password-hash.mjs'));
        symlinkSync(path.resolve('node_modules'), path.join(appDir, 'server', 'node_modules'));

        const runCallback = (password: string) => spawnSync('bash', ['packaging/fnos/cmd/install_callback'], {
            env: {
                ...process.env,
                TRIM_APPDEST: appDir,
                TRIM_PKGVAR: dataDir,
                TRIM_TEMP_LOGFILE: tempLog,
                WN_ADMIN_EMAIL: undefined,
                wizard_admin_email: 'installer@example.test',
                wizard_admin_password: password,
                PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
            },
            encoding: 'utf8',
        });

        const failed = runCallback(legacyAdminPasswordSample);
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('旧版通用密码');
        expect(failed.stderr.includes(legacyAdminPasswordSample)).toBe(false);
        const installLog = readFileSync(path.join(dataDir, 'install.log'), 'utf8');
        const trimTempLog = readFileSync(tempLog, 'utf8');
        expect(installLog).toContain('旧版通用密码');
        expect(installLog.includes(legacyAdminPasswordSample)).toBe(false);
        expect(trimTempLog).toContain('旧版通用密码');
        expect(trimTempLog.includes(legacyAdminPasswordSample)).toBe(false);

        const password = randomBytes(6).toString('base64url');
        const ok = runCallback(password);
        expect(ok.status).toBe(0);
        const initialAdmin = readFileSync(path.join(dataDir, 'config', 'initial-admin.json'), 'utf8');
        expect(compareSync(password, JSON.parse(initialAdmin).passwordHash)).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
