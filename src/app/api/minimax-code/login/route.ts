import { NextResponse } from "next/server";
import { internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { pollLogin, startLogin } from "@/lib/minimax-code/auth";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:minimax-code:login');

export const dynamic = 'force-dynamic';

/** POST /api/minimax-code/login：发起网页登录（OAuth 设备码），返回授权地址（仅管理员） */
export const POST = defineApiRoute({ auth: 'admin' }, async () => {
    try {
        return NextResponse.json(await startLogin());
    } catch (error) {
        logger.error({ error }, 'Failed to start MiniMax Code login');
        return internalError("Failed to start MiniMax Code login");
    }
});

/** GET /api/minimax-code/login：轮询一次授权结果（仅管理员） */
export const GET = defineApiRoute({ auth: 'admin' }, async () => {
    try {
        return NextResponse.json(await pollLogin());
    } catch (error) {
        logger.error({ error }, 'Failed to poll MiniMax Code login');
        return internalError("Failed to poll MiniMax Code login");
    }
});
