import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { flushBackgroundTasksToDb, purgeUserBackgroundTasks } from "@/lib/background-tasks";
import { DEFAULT_ADMIN_EMAIL } from "@/lib/default-admin";
import { createLogger } from "@/lib/logger";
import { purgeUserRecoverableResponses } from "@/lib/recoverable-response";
import { getRequestContext, runWithRequestContext } from "@/lib/server/request-context";
import { purgeUserFromSpeechCache } from "@/lib/tts/speech-cache";
import { USER_SAFE_SELECT } from "@/lib/user-select";

const logger = createLogger("user-deletion");

export type UserDeletionErrorCode =
    | "NOT_FOUND"
    | "PROTECTED_DEFAULT_ADMIN"
    | "LAST_ACTIVE_ADMIN";

export class UserDeletionError extends Error {
    readonly code: UserDeletionErrorCode;

    constructor(code: UserDeletionErrorCode, message?: string) {
        super(message || code);
        this.name = "UserDeletionError";
        this.code = code;
    }
}

export interface DeleteUserAccountParams {
    targetUserId: string;
    actorKind: "self" | "admin";
}

/**
 * 在单一数据库事务中彻底删除账户及其全部关联学习数据与审计记录，
 * 事务成功后同步清理进程内热缓存与该用户独占的 TTS 磁盘语音缓存，
 * 仅记录一条不含个人身份信息（PII）的匿名审计日志。
 */
export async function deleteUserAccount(db: PrismaClient, params: DeleteUserAccountParams) {
    const { targetUserId, actorKind } = params;

    const targetUser = await db.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, role: true, isActive: true },
    });
    if (!targetUser) {
        throw new UserDeletionError("NOT_FOUND", "User not found");
    }

    if (targetUser.email.toLowerCase() === DEFAULT_ADMIN_EMAIL.toLowerCase()) {
        throw new UserDeletionError("PROTECTED_DEFAULT_ADMIN", "Cannot delete super admin");
    }

    if (targetUser.role === "admin" && targetUser.isActive !== false) {
        const otherActiveAdmins = await db.user.count({
            where: { role: "admin", isActive: true, id: { not: targetUserId } },
        });
        if (otherActiveAdmins === 0) {
            throw new UserDeletionError("LAST_ACTIVE_ADMIN", "Cannot delete the last active admin");
        }
    }

    await flushBackgroundTasksToDb();

    const deletedUser = await db.$transaction(async (tx) => {
        // 1. 删除无外键级联关系的历史回填审计记录
        await tx.learnerBackfillAudit.deleteMany({ where: { userId: targetUserId } });

        // 2. 先解除自定义知识点标签树的自引用 parentId，再删除用户自定义标签（保留全局 isSystem 标签）
        await tx.knowledgeTag.updateMany({
            where: { userId: targetUserId, isSystem: false },
            data: { parentId: null },
        });
        await tx.knowledgeTag.deleteMany({
            where: { userId: targetUserId, isSystem: false },
        });

        // 3. 删除主账户，由 Prisma schema 外键 onDelete: Cascade 级联清理全部业务表与作业表；
        //    共享去重的 AiProvenance 不含 PII，保留以免破坏其他用户错题溯源引用。
        return tx.user.delete({
            where: { id: targetUserId },
            select: USER_SAFE_SELECT,
        });
    });

    purgeUserBackgroundTasks(targetUserId);
    purgeUserRecoverableResponses(targetUserId);
    try {
        await purgeUserFromSpeechCache(targetUserId);
    } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to purge TTS cache after user deletion");
    }

    const requestId = getRequestContext()?.requestId ?? crypto.randomUUID();
    runWithRequestContext({ requestId }, () => {
        logger.info(
            {
                event: "user_account_deleted",
                actorKind,
                deletedAt: new Date().toISOString(),
            },
            "User account permanently deleted",
        );
    });

    return deletedUser;
}
