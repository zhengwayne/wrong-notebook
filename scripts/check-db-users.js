/**
 * 数据库用户检查脚本
 * 功能：列出数据库中用户的 ID 和邮箱。
 * 用途：用于确认用户注册情况，获取用户 ID 用于调试。
 */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient({});

async function main() {
    try {
        const users = await prisma.user.findMany({ select: { id: true, email: true } });
        console.log('Users found:', users.length);
        users.forEach(u => console.log(`- ${u.email} (${u.id})`));
    } catch (e) {
        console.error('Error:', e.message);
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}

main();
