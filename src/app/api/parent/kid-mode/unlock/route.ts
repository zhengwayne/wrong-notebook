import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { badRequest, createErrorResponse, ErrorCode, tooManyRequests } from '@/lib/api-errors';
import {
    PARENT_PIN_LOCKOUT_MS,
    PARENT_PIN_MAX_ATTEMPTS,
    buildKidModeClearCookie,
    isRequestHttps,
} from '@/lib/kid-mode-lock';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

const logger = createLogger('api:parent:kid-mode:unlock');

const unlockSchema = z.object({
    pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits'),
});

export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: 4096, bodySchema: unlockSchema },
    async (req, { user, body }) => {
        const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
                parentPinHash: true,
                parentPinFailedCount: true,
                parentPinLockedUntil: true,
            },
        });
        if (!dbUser?.parentPinHash) {
            return badRequest('当前账户尚未设置家长 PIN 码');
        }

        const now = Date.now();
        if (dbUser.parentPinLockedUntil && dbUser.parentPinLockedUntil.getTime() > now) {
            const retryMs = dbUser.parentPinLockedUntil.getTime() - now;
            return tooManyRequests(retryMs, 'PIN 连续输错次数过多，请稍后再试');
        }

        const valid = await bcrypt.compare(body.pin, dbUser.parentPinHash);
        if (!valid) {
            const lockExpired = Boolean(dbUser.parentPinLockedUntil && dbUser.parentPinLockedUntil.getTime() <= now);
            const nextCount = (lockExpired ? 0 : dbUser.parentPinFailedCount) + 1;
            const shouldLock = nextCount >= PARENT_PIN_MAX_ATTEMPTS;

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    parentPinFailedCount: nextCount,
                    parentPinLockedUntil: shouldLock ? new Date(now + PARENT_PIN_LOCKOUT_MS) : null,
                },
            });

            if (shouldLock) {
                logger.warn({ userId: user.id }, 'Kid mode unlock locked out for 15 minutes');
                return tooManyRequests(PARENT_PIN_LOCKOUT_MS, 'PIN 连续输错 5 次，已锁定 15 分钟');
            }

            const remainingAttempts = PARENT_PIN_MAX_ATTEMPTS - nextCount;
            return createErrorResponse(
                `PIN 码错误，还可尝试 ${remainingAttempts} 次`,
                403,
                ErrorCode.FORBIDDEN,
                { remainingAttempts },
            );
        }

        await prisma.user.update({
            where: { id: user.id },
            data: {
                parentPinFailedCount: 0,
                parentPinLockedUntil: null,
            },
        });

        const response = NextResponse.json({ active: false, unlocked: true });
        response.headers.set('Set-Cookie', buildKidModeClearCookie(isRequestHttps(req)));
        return response;
    },
);
