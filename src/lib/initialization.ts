import { prisma } from "@/lib/prisma";
import { readInitialAdmin, removeInitialAdmin } from "@/lib/initial-admin";
import { createLogger } from "@/lib/logger";
import { ensureSetupToken, removeSetupToken, setupTokenFilePath } from "@/lib/setup-token";
import { findUserByEmailInsensitive, normalizeEmail } from "@/lib/email";

const logger = createLogger("initialization");

/** 至少有一个管理员即视为已初始化；全新安装不再预置默认管理员 */
export async function isInitialized(): Promise<boolean> {
    return (await prisma.user.count({ where: { role: "admin" } })) > 0;
}

/** 用安装程序预设的管理员（initial-admin.json）创建账号；成功返回 true，没有或无效时返回 false */
async function createPresetAdmin(): Promise<boolean> {
    let preset;
    try {
        preset = readInitialAdmin();
    } catch (error) {
        logger.error({ error }, "Invalid initial-admin.json; falling back to the setup link");
        removeInitialAdmin();
        return false;
    }
    if (!preset) return false;
    const normalizedEmail = normalizeEmail(preset.email);

    if (await findUserByEmailInsensitive(prisma, normalizedEmail, { id: true })) {
        logger.error({ email: normalizedEmail }, "Preset admin email already exists; falling back to the setup link");
        removeInitialAdmin();
        return false;
    }
    const user = await prisma.user.create({
        data: { email: normalizedEmail, name: preset.name || "Admin", password: preset.passwordHash, role: "admin", isActive: true },
        select: { id: true },
    });
    removeInitialAdmin();
    removeSetupToken();
    logger.info({ userId: user.id, email: preset.email }, "Admin created from installer settings");
    return true;
}

/**
 * 服务启动时调用：尚未初始化时，优先使用安装程序预设的管理员；
 * 没有预设时生成令牌并在日志中提示文件位置。已初始化时删除残留的令牌和预设文件
 */
export async function announceSetupLink(): Promise<void> {
    try {
        if (await isInitialized()) {
            removeSetupToken();
            removeInitialAdmin();
            return;
        }
        if (await createPresetAdmin()) return;
        ensureSetupToken();
        logger.warn(`尚未创建管理员。读取 ${setupTokenFilePath()} 中的一次性令牌。在浏览器地址栏输入本站地址，接上 /initialize?token= 并在等号后粘贴令牌，再打开页面。`);
    } catch (error) {
        // 只读文件系统（如 Vercel）或数据库尚未就绪时不影响服务启动
        logger.error({ error }, "Failed to prepare setup link");
    }
}
