import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api-errors";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { readMiniProgramBearer, revokeMiniProgramToken, toMiniProgramUserProfile } from "@/lib/server/mp-auth";
import { getKidModeLearnerId } from "@/lib/server/request-context";

/** GET /api/mp/session：当前小程序登录身份与专注锁状态（专注锁下也允许读取） */
export const GET = defineApiRoute({ auth: "user" }, async (_req, { user, session }) => {
    return NextResponse.json({
        user: toMiniProgramUserProfile(user, parsePersonas),
        expiresAt: session.expires,
        kidModeLearnerId: getKidModeLearnerId() ?? null,
    });
});

/** DELETE /api/mp/session：退出小程序登录，只作废当前令牌（专注锁下不允许，与网页端退出一致） */
export const DELETE = defineApiRoute({ auth: "user" }, async (req) => {
    const token = readMiniProgramBearer(req.headers.get("authorization"));
    if (!token) return badRequest("MP_TOKEN_REQUIRED");
    await revokeMiniProgramToken(prisma, token);
    return NextResponse.json({ ok: true });
});
