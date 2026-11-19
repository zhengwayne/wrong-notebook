const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PrismaClient } = require('@prisma/client');
const { compare, hash } = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;
const prisma = new PrismaClient();

async function isLegacyDefaultPassword(candidate) {
    const mod = await import(pathToFileURL(path.resolve(__dirname, '../src/lib/legacy-admin-password-hash.mjs')).href);
    return compare(candidate, mod.legacyAdminPasswordHash);
}

async function main() {
    const rawEmail = process.argv[2];
    const newPassword = process.argv[3];
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || typeof newPassword !== 'string' || newPassword.length === 0) {
        console.error('\nUsage: node reset-password.js <email> <new_password>');
        process.exitCode = 1;
        return;
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        console.error(`\n密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位。`);
        process.exitCode = 1;
        return;
    }

    if (await isLegacyDefaultPassword(newPassword)) {
        console.error('\n不能使用已弃用的弱默认口令，请设置更强的密码。');
        process.exitCode = 1;
        return;
    }

    // 优先按规范小写匹配，兼容历史库中含大写字母的邮箱
    let user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) {
        const users = await prisma.user.findMany({ select: { id: true, email: true } });
        user = users.find((candidate) => candidate.email.trim().toLowerCase() === email) ?? null;
    }
    if (!user) {
        console.error('\n密码重置失败：未找到对应邮箱账号。');
        process.exitCode = 1;
        return;
    }

    const hashedPassword = await hash(newPassword, 12);

    await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, authVersion: { increment: 1 } },
    });
    console.log(`\nPassword for ${user.email} has been reset successfully.`);
}

main()
    .catch(e => {
        console.error('密码重置失败。', e.code || e.name);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
