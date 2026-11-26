import { analyzeImageForUser } from "@/lib/server/analyze-image";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { badRequest } from "@/lib/api-errors";
import { defineApiRoute, type AuthenticatedRouteContext } from "@/lib/server/api-route";

async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return badRequest("Invalid JSON body");
    }
    if (!body || typeof body !== "object") return badRequest("Missing image data");
    return analyzeImageForUser(user, body, { request: req });
}

/** 耗时 AI 请求：浏览器中断连接后，前端可通过 /api/requests/:id 取回响应 */
export const POST = defineApiRoute({ auth: 'user' }, withRecoverableResponse(handlePost));
