import { compareSync } from 'bcryptjs';
import { legacyAdminPasswordHash } from './legacy-admin-password-hash.mjs';

/** 旧版安装可能创建的管理员邮箱。新安装由部署者通过一次性令牌自行设置账号。 */
export const DEFAULT_ADMIN_EMAIL = 'admin@localhost';

/** 仅识别历史通用口令，精确匹配后引导改密；在 HTTP 局域网的浏览器中也可运行。 */
export function isDefaultAdminPassword(role: string | null | undefined, password: string): boolean {
    return role === 'admin' && password.length === 6 && compareSync(password, legacyAdminPasswordHash);
}
