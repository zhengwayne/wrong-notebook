import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { hash } from "bcryptjs";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { conflict, unauthorized, notFound, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { isDefaultAdminPassword } from "@/lib/default-admin";
import { syncMasteryLevels } from "@/lib/mastery";
import { userUpdateSchema } from "@/lib/user-profile-schema";
import { findUserByEmailInsensitive, normalizeEmail } from "@/lib/email";
import type { Prisma } from "@prisma/client";

const logger = createLogger('api:user');

export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const user = await findUserByEmailInsensitive(prisma, session.user.email, {
            name: true,
            email: true,
            educationStage: true,
            enrollmentYear: true,
            gradeRecognitionMode: true,
            fixedGradeSemester: true,
            confirmBeforeImport: true,
            enableGeogebra: true,
            enableSvgAnimation: true,
            variantPipelineEnabled: true,
            themePreference: true,
            questionDuplicateThreshold: true,
            masteryThreshold: true,
            reviewAlgorithmVersion: true,
            // Do not return password
        });

        if (!user) {
            return notFound("User not found");
        }

        logger.debug({ user }, 'Returning user profile');

        return NextResponse.json(user);
    } catch (error) {
        logger.error({ error }, 'Failed to fetch user profile');
        return internalError("Failed to fetch user profile");
    }
}

export async function PATCH(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const body = await req.json();
        const { name, email, password, educationStage, enrollmentYear, gradeRecognitionMode, fixedGradeSemester, confirmBeforeImport, enableGeogebra, enableSvgAnimation, variantPipelineEnabled, themePreference, questionDuplicateThreshold, masteryThreshold, reviewAlgorithmVersion } = userUpdateSchema.parse(body);

        const updateData: Prisma.UserUpdateInput = {};
        if (gradeRecognitionMode !== undefined) updateData.gradeRecognitionMode = gradeRecognitionMode;
        if (fixedGradeSemester !== undefined) updateData.fixedGradeSemester = fixedGradeSemester;

        // 只有非空字符串才会触发更新
        if (name && name.trim()) updateData.name = name.trim();
        if (educationStage && educationStage.trim()) updateData.educationStage = educationStage.trim();
        if (typeof enrollmentYear === 'number' && !isNaN(enrollmentYear)) {
            updateData.enrollmentYear = enrollmentYear;
        }
        if (typeof confirmBeforeImport === 'boolean') {
            updateData.confirmBeforeImport = confirmBeforeImport;
        }
        if (typeof enableGeogebra === 'boolean') {
            updateData.enableGeogebra = enableGeogebra;
        }
        if (typeof enableSvgAnimation === 'boolean') {
            updateData.enableSvgAnimation = enableSvgAnimation;
        }
        if (typeof variantPipelineEnabled === 'boolean') {
            updateData.variantPipelineEnabled = variantPipelineEnabled;
        }
        if (themePreference) {
            updateData.themePreference = themePreference;
        }
        if (typeof questionDuplicateThreshold === 'number') {
            updateData.questionDuplicateThreshold = questionDuplicateThreshold;
        }
        if (typeof masteryThreshold === 'number') {
            updateData.masteryThreshold = masteryThreshold;
        }
        if (reviewAlgorithmVersion) {
            updateData.reviewAlgorithmVersion = reviewAlgorithmVersion;
        }

        // 验证邮箱格式（如果提供了邮箱），归一化为小写并检查是否已被他人占用
        // 支持标准邮箱和本地邮箱（如 admin@localhost）
        if (email && email.trim()) {
            const normalizedEmail = normalizeEmail(email);
            const emailRegex = /^[^\s@]+@[^\s@]+$/;
            if (!emailRegex.test(normalizedEmail)) {
                return badRequest("Invalid email format");
            }
            if (normalizedEmail !== normalizeEmail(session.user.email)) {
                const occupied = await findUserByEmailInsensitive(prisma, normalizedEmail, { id: true, email: true });
                if (occupied && normalizeEmail(occupied.email) !== normalizeEmail(session.user.email)) {
                    return conflict("Email already in use");
                }
            }
            updateData.email = normalizedEmail;
        }

        // 验证密码长度（如果提供了密码）
        if (password && password.length > 0) {
            if (password.length < 6) {
                return badRequest("Password must be at least 6 characters");
            }
            if (isDefaultAdminPassword(session.user.role, password)) {
                return badRequest("New password must not be the default password");
            }
            updateData.password = await hash(password, 10);
        }

        const sessionEmail = session.user.email;
        const updatedUser = await prisma.$transaction(async (tx) => {
            const updated = await tx.user.update({
                where: { email: sessionEmail },
                data: updateData,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    educationStage: true,
                    enrollmentYear: true,
                    gradeRecognitionMode: true,
                    fixedGradeSemester: true,
                    confirmBeforeImport: true,
                    enableGeogebra: true,
                    enableSvgAnimation: true,
                    variantPipelineEnabled: true,
                    themePreference: true,
                    questionDuplicateThreshold: true,
                    masteryThreshold: true,
                    reviewAlgorithmVersion: true,
                }
            });
            // 阈值变化后同步已存的 masteryLevel，与按阈值推导的复习状态保持一致
            if (typeof masteryThreshold === 'number') {
                await syncMasteryLevels(tx, updated.id, masteryThreshold);
            }
            return updated;
        });

        const { id: _id, ...profile } = updatedUser;
        return NextResponse.json(profile);
    } catch (error) {
        logger.error({ error }, 'Failed to update user profile');
        if (error instanceof z.ZodError) {
            return validationError("Invalid input", error.issues);
        }
        return internalError("Failed to update user profile");
    }
}
