/**
 * 管理员显式执行的恢复工具。为已有的 admin@localhost 恢复管理员角色并启用账号。
 * 全新安装不再创建固定密码的管理员，改由部署者读取配置目录的 setup-token 文件创建（见 src/lib/initialization.ts）。
 */
const { PrismaClient } = require('@prisma/client');

const DEFAULT_ADMIN = {
    email: 'admin@localhost',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

async function seedAdmin({ prisma }) {
    const existingUser = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN.email },
    });

    if (!existingUser) {
        return { action: 'skipped', email: DEFAULT_ADMIN.email };
    }

    await prisma.user.update({
        where: { email: DEFAULT_ADMIN.email },
        data: {
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: existingUser.educationStage ?? DEFAULT_ADMIN.educationStage,
            enrollmentYear: existingUser.enrollmentYear ?? DEFAULT_ADMIN.enrollmentYear,
        },
    });
    return { action: 'updated', email: DEFAULT_ADMIN.email };
}

async function main() {
    const prisma = new PrismaClient();

    try {
        const result = await seedAdmin({ prisma });
        if (result.action === 'updated') {
            console.log('Existing admin user found. Restored admin role.');
        } else {
            console.log('No default admin user. Start the server, read the setup-token file listed in its startup log, and append its contents to /initialize?token= at your site.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { seedAdmin, DEFAULT_ADMIN };
