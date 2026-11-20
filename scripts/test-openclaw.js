#!/usr/bin/env node
/** 无目标地址时运行离线套件；显式选择实例后检查认证，传入图片路径时同时验证导入。 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    const target = process.env.WRONG_NOTEBOOK_URL;
    const file = process.argv[2];
    if (!target) {
        if (file) throw new Error('上传测试图片需要显式设置 WRONG_NOTEBOOK_URL。');
        const root = path.resolve(__dirname, '..');
        const result = spawnSync(process.execPath, [
            path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'src/__tests__/integration/openclaw-security.test.ts',
        ], { cwd: root, stdio: 'inherit' });
        process.exitCode = result.status ?? 1;
        return;
    }

    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('WRONG_NOTEBOOK_URL 需要是 HTTP 或 HTTPS 服务地址，且不含凭据或查询参数。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '') + '/api/openclaw/batch-upload';
    const mode = process.env.OPENCLAW_AUTH_MODE || 'credentials';
    const identity = process.env.OPENCLAW_TEST_USER;
    if (!identity) throw new Error('请通过 OPENCLAW_TEST_USER 指定测试账号。');
    const headers = { 'Content-Type': 'application/json' };
    const images = [];
    const body = { images };
    if (mode === 'apikey') {
        const key = process.env.OPENCLAW_INTEGRATION_API_KEY;
        if (!key) throw new Error('请设置 OPENCLAW_INTEGRATION_API_KEY。');
        headers['x-api-key'] = key;
        body.userEmail = identity;
    } else if (mode === 'credentials') {
        const password = process.env.OPENCLAW_TEST_PASSWORD;
        if (!password) throw new Error('请设置 OPENCLAW_TEST_PASSWORD。');
        body.username = identity;
        body.password = password;
    } else {
        throw new Error('OPENCLAW_AUTH_MODE 需要是 credentials 或 apikey。');
    }
    if (file) {
        const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(file).toLowerCase()];
        if (!mimeType || fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的 PNG 或 JPEG 图片。');
        images.push({ base64: fs.readFileSync(file).toString('base64'), mimeType, filename: path.basename(file) });
    }

    const response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    const data = await response.json().catch(() => null);
    const passed = file ? response.status === 201 && data?.successCount === 1 :
        response.status === 400 && data?.details === 'Missing images array';
    if (!passed) throw new Error(`Openclaw 检查失败，HTTP ${response.status}。`);
    console.log(file ? '测试图片导入成功。' : '接口接受了本次认证，未提交图片。');
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
