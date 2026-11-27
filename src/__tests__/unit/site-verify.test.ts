/** 站点根目录校验文件：只读配置目录 site-verify/ 下的同名 .txt，放进去立即生效 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSiteVerifyFile, siteVerifyDir, siteVerifyName } from '@/lib/server/site-verify';
import { GET } from '@/app/api/site-verify/[name]/route';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-verify-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SITE_VERIFY_DIR;
});

describe('site-verify', () => {
    it('路径形状：只认根路径下的 字母数字_- .txt', () => {
        expect(siteVerifyName('/abcDEF123_-x.txt')).toBe('abcDEF123_-x');
        for (const bad of ['/a/b.txt', '/.txt', '/a.TXT', '/a.txt/', '/../a.txt', '/a%2Fb.txt', '/' + 'a'.repeat(65) + '.txt']) expect(siteVerifyName(bad)).toBeNull();
    });

    it('默认目录在配置目录下，可用 SITE_VERIFY_DIR 指定', () => {
        expect(siteVerifyDir({ CONFIG_DIR: '/app/config' })).toBe('/app/config/site-verify');
        expect(siteVerifyDir({ SITE_VERIFY_DIR: '/srv/verify', CONFIG_DIR: '/app/config' })).toBe('/srv/verify');
    });

    it('读取存在的文件；不存在、非法名、符号链接、超大文件都返回 null', async () => {
        fs.writeFileSync(path.join(dir, 'ok123.txt'), 'abc123');
        expect(await readSiteVerifyFile('ok123', dir)).toBe('abc123');
        expect(await readSiteVerifyFile('missing', dir)).toBeNull();
        expect(await readSiteVerifyFile('../etc/passwd', dir)).toBeNull();
        fs.writeFileSync(path.join(os.tmpdir(), 'site-verify-secret.txt'), 'secret');
        fs.symlinkSync(path.join(os.tmpdir(), 'site-verify-secret.txt'), path.join(dir, 'link.txt'));
        expect(await readSiteVerifyFile('link', dir)).toBeNull();
        fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(5000));
        expect(await readSiteVerifyFile('big', dir)).toBeNull();
    });

    it('接口：有文件返回 200 纯文本，无文件 404', async () => {
        process.env.SITE_VERIFY_DIR = dir;
        fs.writeFileSync(path.join(dir, 'f00d.txt'), 'f00dcontent');
        const ok = await GET(new Request('http://localhost/api/site-verify/f00d'), { params: Promise.resolve({ name: 'f00d' }) });
        expect(ok.status).toBe(200);
        expect(ok.headers.get('content-type')).toContain('text/plain');
        expect(await ok.text()).toBe('f00dcontent');
        const missing = await GET(new Request('http://localhost/api/site-verify/nope'), { params: Promise.resolve({ name: 'nope' }) });
        expect(missing.status).toBe(404);
    });
});
