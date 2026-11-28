import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

type UserLookupClient = Pick<PrismaClient, 'user'> & Partial<Pick<PrismaClient, '$queryRaw'>>;

/** 将邮箱地址归一化为去除首尾空白的小写格式 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/**
 * 按邮箱大小写不敏感查找用户：
 * 1) 先以归一化小写精确命中 UNIQUE 索引（兼顾单测最小 Prisma mock）；
 * 2) 若输入含大写且未命中，回退原始去空白字符串（匹配历史混合大小写库记录）；
 * 3) 若仍未命中且连接支持 `$queryRaw`，用 SQLite `LOWER(email)` 查找 id 后回查完整用户。
 */
export async function findUserByEmailInsensitive<TSelect extends Prisma.UserSelect | undefined = undefined>(
    client: UserLookupClient,
    rawEmail: string,
    select?: TSelect,
): Promise<Prisma.UserGetPayload<{ select: TSelect }> | null> {
    const trimmed = rawEmail.trim();
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();

    const queryOptions = select ? { select } : {};
    const byNormalized = await client.user.findUnique({
        where: { email: normalized },
        ...queryOptions,
    } as Prisma.UserFindUniqueArgs);
    if (byNormalized) {
        return byNormalized as Prisma.UserGetPayload<{ select: TSelect }>;
    }

    if (trimmed !== normalized) {
        const byTrimmed = await client.user.findUnique({
            where: { email: trimmed },
            ...queryOptions,
        } as Prisma.UserFindUniqueArgs);
        if (byTrimmed) {
            return byTrimmed as Prisma.UserGetPayload<{ select: TSelect }>;
        }
    }

    if (typeof client.$queryRaw === 'function') {
        const rows = await client.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT id FROM "User" WHERE LOWER(email) = ${normalized} LIMIT 1`,
        );
        const matchedId = rows[0]?.id;
        if (matchedId) {
            const byId = await client.user.findUnique({
                where: { id: matchedId },
                ...queryOptions,
            } as Prisma.UserFindUniqueArgs);
            return (byId as Prisma.UserGetPayload<{ select: TSelect }> | null) ?? null;
        }
    }

    return null;
}

/**
 * Openclaw 凭据登录用户查找：同时支持邮箱（大小写不敏感）与用户名精确匹配。
 */
export async function findUserByLoginIdentifier(
    client: UserLookupClient,
    identifier: string,
) {
    const trimmed = identifier.trim();
    if (!trimmed) return null;

    const byEmail = await findUserByEmailInsensitive(client, trimmed);
    if (byEmail) return byEmail;

    return client.user.findFirst({
        where: { name: trimmed },
    });
}
