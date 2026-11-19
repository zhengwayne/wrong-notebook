import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { badRequest, forbidden, tooManyRequests } from '@/lib/api-errors';
import { PARENT_PIN_LOCKOUT_MS, PARENT_PIN_MAX_ATTEMPTS } from '@/lib/kid-mode-lock';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

const logger = createLogger('api:parent:pin');

const setPinSchema = z.object({
    pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
    currentPin: z.string().regex(/^\d{4}$/).optional(),
});

export const GET = defineApiRoute({ auth: 'user' }, async (_req, { user }) => {
    const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { parentPinHash: true, parentPinLockedUntil: true },
    });
    const now = Date.now();
    const lockedUntil = row?.parentPinLockedUntil && row.parentPinLockedUntil.getTime() > now
        ? row.parentPinLockedUntil.toISOString()
        : null;

    return NextResponse.json({
        hasPin: Boolean(row?.parentPinHash),
        lockedUntil,
    });
});

export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: 4096, bodySchema: setPinSchema },
    async (_req, { user, body }) => {
        const existing = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
                parentPinHash: true,
                parentPinFailedCount: true,
                parentPinLockedUntil: true,
            },
        });
        if (!existing) {
            return badRequest('User not found');
        }

        const now = Date.now();
        if (existing.parentPinLockedUntil && existing.parentPinLockedUntil.getTime() > now) {
            const retryMs = existing.parentPinLockedUntil.getTime() - now;
            return tooManyRequests(retryMs, 'PIN 输错次数过多，请稍后再试');
        }

        if (existing.parentPinHash) {
            if (!body.currentPin) {
                return badRequest('修改家长 PIN 码时需提供原 PIN 码');
            }
            const matches = await bcrypt.compare(body.currentPin, existing.parentPinHash);
            if (!matches) {
                const lockExpired = Boolean(existing.parentPinLockedUntil && existing.parentPinLockedUntil.getTime() <= now);
                const nextFailed = (lockExpired ? 0 : existing.parentPinFailedCount) + 1;
                const shouldLock = nextFailed >= PARENT_PIN_MAX_ATTEMPTS;
                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        parentPinFailedCount: nextFailed,
                        parentPinLockedUntil: shouldLock ? new Date(now + PARENT_PIN_LOCKOUT_MS) : null,
                    },
                });
                if (shouldLock) {
                    logger.warn({ userId: user.id }, 'Parent PIN change locked due to repeated failures');
                    return tooManyRequests(PARENT_PIN_LOCKOUT_MS, 'PIN 连续输错 5 次，已锁定 15 分钟');
                }
                return forbidden('原 PIN 码不正确');
            }
        }

        const hashed = await bcrypt.hash(body.pin, 10);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                parentPinHash: hashed,
                parentPinFailedCount: 0,
                parentPinLockedUntil: null,
            },
        });

        logger.info({ userId: user.id }, 'Parent PIN updated');
        return NextResponse.json({ hasPin: true });
    },
);
