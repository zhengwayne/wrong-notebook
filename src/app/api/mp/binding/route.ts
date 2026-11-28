import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { conflict } from "@/lib/api-errors";
import { getMiniProgramConfig, revokeUserMiniProgramSessions } from "@/lib/server/mp-auth";
import { isWechatPlaceholderEmail } from "@/lib/wechat-account";

/** GET /api/mp/binding：当前账号是否绑定了微信（网页端设置页也可调用） */
export const GET = defineApiRoute({ auth: "user" }, async (_req, { user }) => {
    const appId = getMiniProgramConfig()?.appId;
    const binding = appId
        ? await prisma.wechatBinding.findUnique({
            where: { appId_userId: { appId, userId: user.id } },
            select: { createdAt: true, lastLoginAt: true },
        })
        : null;
    return NextResponse.json({
        configured: Boolean(appId),
        bound: Boolean(binding),
        wechatOnly: isWechatPlaceholderEmail(user.email),
        boundAt: binding?.createdAt ?? null,
        lastLoginAt: binding?.lastLoginAt ?? null,
    });
});

/**
 * DELETE /api/mp/binding：解除本账号的微信绑定并作废全部小程序会话（专注锁下不允许）。
 * 仅微信登录的账号没有其他登录方式，解绑后将再也进不去，因此拒绝（409 WECHAT_ONLY_ACCOUNT）。
 */
export const DELETE = defineApiRoute({ auth: "user" }, async (_req, { user }) => {
    if (isWechatPlaceholderEmail(user.email)) return conflict("WECHAT_ONLY_ACCOUNT");
    const removed = await prisma.$transaction(async (tx) => {
        const result = await tx.wechatBinding.deleteMany({ where: { userId: user.id } });
        await revokeUserMiniProgramSessions(tx, user.id);
        return result.count;
    });
    return NextResponse.json({ ok: true, removed });
});
