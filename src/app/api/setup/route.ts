import { NextResponse } from "next/server";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:setup');

export const dynamic = 'force-dynamic';

/**
 * GET /api/setup
 * 安装向导状态：未完成向导且还没有任何错题本时需要进入向导，
 * 已在使用的旧实例（已有错题本）升级后不会被打扰
 */
export const GET = defineApiRoute({ auth: 'admin' }, async () => {
    try {
        const setupCompleted = !!getAppConfig().setupCompletedAt;
        const needsSetup = !setupCompleted && (await prisma.subject.count()) === 0;
        return NextResponse.json({ setupCompleted, needsSetup });
    } catch (error) {
        logger.error({ error }, 'Failed to get setup status');
        return internalError("Failed to get setup status");
    }
});

/**
 * POST /api/setup
 * 完成或跳过安装向导，之后不再自动进入
 */
export const POST = defineApiRoute({ auth: 'admin' }, async (_req, { user }) => {
    try {
        const setupCompletedAt = new Date().toISOString();
        updateAppConfig({ setupCompletedAt });
        logger.info({ userId: user.id }, 'Setup wizard completed');
        return NextResponse.json({ setupCompleted: true, setupCompletedAt });
    } catch (error) {
        logger.error({ error }, 'Failed to complete setup');
        return internalError("Failed to complete setup");
    }
});
