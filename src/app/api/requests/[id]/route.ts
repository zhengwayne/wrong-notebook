import { NextResponse } from "next/server";
import { getKidModeLockFromRequest } from "@/lib/kid-mode-lock";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized } from "@/lib/api-errors";
import { getStoredResponse, parseRequestId } from "@/lib/recoverable-response";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/requests/:id
 * 取回被浏览器中断的耗时请求的结果：{ state: 'running' } 或 { state: 'done', status, body }；
 * 请求没有到达服务端或结果已过期时返回 404。
 * 小程序多图识别在上传超时或网关断开时用它轮询结果（Bearer 令牌鉴权）。
 */
export async function GET(req: Request, { params }: RouteContext) {
    const user = await getCurrentUser(req);
    if (!user) {
        return unauthorized("Authentication required");
    }
    const id = parseRequestId((await params).id);
    const lock = getKidModeLockFromRequest(req, { userId: user.id, authVersion: user.authVersion });
    const stored = id ? await getStoredResponse(id, user.id, lock?.learnerId) : null;
    if (!stored) {
        return notFound("Request not found");
    }
    return NextResponse.json(stored);
}
