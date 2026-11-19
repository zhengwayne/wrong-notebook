const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
    const rawEmail = process.argv[2];
    const newPassword = process.argv[3];
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || !newPassword) {
        console.error('\nUsage: node reset-password.js <email> <new_password>');
        process.exitCode = 1;
        return;
    }

    const hashedPassword = await hash(newPassword, 12);

    await prisma.user.update({
        where: { email },
        data: { password: hashedPassword, authVersion: { increment: 1 } },
    });
    console.log(`\nPassword for ${email} has been reset successfully.`);
}

main()
    .catch(e => {
        console.error('密码重置失败。', e.code || e.name);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
