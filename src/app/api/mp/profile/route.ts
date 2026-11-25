import { NextResponse } from "next/server";
import { z } from "zod";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { toMiniProgramUserProfile } from "@/lib/server/mp-auth";

const bodySchema = z.object({
    name: z.string().trim().min(1, "NAME_REQUIRED").max(30, "NAME_TOO_LONG"),
});

/**
 * POST /api/mp/profile { name }：修改显示名称（小程序 wx.request 不支持 PATCH，所以单独提供 POST）。
 * 只改名称，邮箱和密码请到网页端设置；专注锁下不允许（网关白名单之外）。
 */
export const POST = defineApiRoute(
    { auth: "user", maxBodyBytes: 2048, bodySchema },
    async (_req, { user, body }) => {
        const updated = await prisma.user.update({
            where: { id: user.id },
            data: { name: body.name },
            select: {
                id: true, email: true, name: true, role: true,
                personas: true, activePersona: true, personasConfirmedAt: true,
            },
        });
        return NextResponse.json({ user: toMiniProgramUserProfile(updated, parsePersonas) });
    },
);
