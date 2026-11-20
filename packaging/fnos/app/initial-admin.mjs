/**
 * 飞牛OS 安装向导设置管理员：install_callback 调用，把向导中填写的邮箱和密码哈希
 * 写入配置目录的 initial-admin.json（不保存明文密码），服务首次启动时据此创建管理员。
 * 邮箱和密码经环境变量传入，避免出现在进程参数中。
 *
 * 用法：WN_ADMIN_EMAIL=… WN_ADMIN_PASSWORD=… node initial-admin.mjs <服务端目录> <输出文件>
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyAdminPasswordHash } from './legacy-admin-password-hash.mjs';

const [serverDir, outFile] = process.argv.slice(2);
const email = (process.env.WN_ADMIN_EMAIL || '').trim();
const password = process.env.WN_ADMIN_PASSWORD || '';

if (!serverDir || !outFile) {
    console.error('用法：node initial-admin.mjs <服务端目录> <输出文件>');
    process.exit(2);
}
// 与服务端初始化接口的校验一致
if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    console.error('管理员邮箱格式不正确');
    process.exit(1);
}
// standalone 构建只保留 bcryptjs 的 ESM 入口（index.js），不能用 require 加载
const { default: bcrypt } = await import(pathToFileURL(path.join(serverDir, 'node_modules', 'bcryptjs', 'index.js')).href);
if (password.length < 6 || (password.length === 6 && bcrypt.compareSync(password, legacyAdminPasswordHash))) {
    console.error('管理员密码至少 6 位，且不能使用旧版通用密码');
    process.exit(1);
}

const content = JSON.stringify({ email, name: 'Admin', passwordHash: bcrypt.hashSync(password, 12) });

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const tmp = `${outFile}.tmp`;
fs.writeFileSync(tmp, content, { mode: 0o600 });
fs.renameSync(tmp, outFile);
