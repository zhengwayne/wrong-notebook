/**
 * 站点根目录的校验文件（如微信小程序「业务域名」校验文件 /<随机名>.txt）。
 * 文件放在配置目录的 site-verify/ 下（Docker 部署即 /opt/xueji/config/site-verify/），放进去立即生效，不用重新构建镜像。
 * 只认根路径下“字母数字、下划线、连字符 + .txt”的文件名，不跟随符号链接，单个文件不超过 4KB。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export { SITE_VERIFY_PATH_RE, siteVerifyName } from '@/lib/site-verify-path';
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 4096;

export function siteVerifyDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
    if (env.SITE_VERIFY_DIR) return path.resolve(env.SITE_VERIFY_DIR);
    return path.resolve(env.CONFIG_DIR || path.join(process.cwd(), 'config'), 'site-verify');
}

export async function readSiteVerifyFile(name: string, dir: string = siteVerifyDir()): Promise<string | null> {
    if (!NAME_RE.test(name)) return null;
    const file = path.join(dir, `${name}.txt`);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        return await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
}
