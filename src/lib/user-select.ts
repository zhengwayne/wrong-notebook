import type { Prisma } from '@prisma/client';

/**
 * 面向管理接口或通用用户响应的安全字段白名单，显式排除 password 等敏感/内部字段。
 */
export const USER_SAFE_SELECT = {
    id: true,
    name: true,
    email: true,
    role: true,
    isActive: true,
    educationStage: true,
    enrollmentYear: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.UserSelect;
