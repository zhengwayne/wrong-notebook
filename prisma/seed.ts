import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 全新安装不再创建固定密码的默认管理员：由部署者按服务启动日志给出的文件路径读取一次性令牌，
 * 再打开初始化页面设置管理员账号（见 src/lib/initialization.ts）。这里只提示当前状态。
 */
async function main() {
    const admins = await prisma.user.count({ where: { role: 'admin' } });
    if (admins > 0) {
        console.log(`Found ${admins} admin user(s). Nothing to seed.`);
        return;
    }
    console.log('No admin user yet. Start the server, read the setup-token file listed in its startup log, and append its contents to /initialize?token= at your site.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
