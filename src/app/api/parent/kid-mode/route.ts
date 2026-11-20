import { NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, notFound } from '@/lib/api-errors';
import {
    KID_MODE_DEFAULT_TTL_SECONDS,
    buildKidModeSetCookie,
    getKidModeLockFromRequest,
    isRequestHttps,
    signKidModeToken,
} from '@/lib/kid-mode-lock';
import { LEARNER_KIND } from '@/lib/learners';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

const enableKidModeSchema = z.object({
    learnerId: z.string().trim().min(1).max(64),
});

export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const lock = getKidModeLockFromRequest(req, {
        userId: user.id,
        authVersion: user.authVersion,
    });
    const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { parentPinHash: true, parentPinLockedUntil: true },
    });
    const now = Date.now();
    const lockedUntil = dbUser?.parentPinLockedUntil && dbUser.parentPinLockedUntil.getTime() > now
        ? dbUser.parentPinLockedUntil.toISOString()
        : null;

    return NextResponse.json({
        active: Boolean(lock),
        learnerId: lock?.learnerId ?? null,
        learnerName: lock?.learnerName ?? null,
        hasPin: Boolean(dbUser?.parentPinHash),
        lockedUntil,
    });
});

export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: 4096, bodySchema: enableKidModeSchema },
    async (req, { user, body }) => {
        const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { parentPinHash: true, authVersion: true },
        });
        if (!dbUser?.parentPinHash) {
            return badRequest('请先设置 4 位家长 PIN 码后再开启孩子专注模式');
        }

        const learner = await prisma.learner.findFirst({
            where: {
                id: body.learnerId,
                userId: user.id,
                kind: LEARNER_KIND.child,
                archivedAt: null,
            },
            select: { id: true, name: true },
        });
        if (!learner) {
            return notFound('未找到该孩子档案');
        }

        const exp = Math.floor(Date.now() / 1000) + KID_MODE_DEFAULT_TTL_SECONDS;
        const signed = signKidModeToken({
            userId: user.id,
            learnerId: learner.id,
            learnerName: learner.name,
            authVersion: dbUser.authVersion,
            exp,
        });

        const response = NextResponse.json({
            active: true,
            learnerId: learner.id,
            learnerName: learner.name,
        });
        response.headers.set('Set-Cookie', buildKidModeSetCookie(signed, isRequestHttps(req)));
        return response;
    },
);
