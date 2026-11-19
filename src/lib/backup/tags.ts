import type { Prisma } from '@prisma/client';
import { BackupError } from '@/lib/backup/errors';

export interface BackupCustomTag {
    id: string;
    name: string;
    userId: string;
    subject: string;
    parentId: string | null;
    systemParentPath?: unknown;
    order: number;
    code: string | null;
}

function ambiguousTag(): never {
    throw new BackupError('BACKUP_TAG_AMBIGUOUS', 'Cannot match the knowledge tag hierarchy in this backup', 409);
}

interface SystemTagIndex {
    paths: Map<string, { subject: string; path: string[] }>;
    parentIds: Set<string>;
}

async function loadSystemTagIndex(tx: Prisma.TransactionClient): Promise<SystemTagIndex> {
    const rows = await tx.knowledgeTag.findMany({
        where: { isSystem: true },
        select: { id: true, parentId: true, name: true, subject: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const paths = new Map<string, { subject: string; path: string[] }>();
    const parentIds = new Set<string>();
    for (const row of rows) {
        if (row.parentId) parentIds.add(row.parentId);
        const path = [row.name];
        const seen = new Set([row.id]);
        let parentId = row.parentId;
        while (parentId) {
            const parent = byId.get(parentId);
            if (!parent || seen.has(parentId)) ambiguousTag();
            path.push(parent.name);
            seen.add(parentId);
            parentId = parent.parentId;
        }
        paths.set(row.id, { subject: row.subject, path: path.reverse() });
    }
    return { paths, parentIds };
}

/** 系统标签的数据库 ID 随部署和重建而变化，备份使用学科与完整教材路径定位。 */
export async function loadSystemTagPaths(tx: Prisma.TransactionClient) {
    const { paths } = await loadSystemTagIndex(tx);
    return paths;
}

export async function restoreBackupTags(
    tx: Prisma.TransactionClient,
    rows: BackupCustomTag[],
    warnings: Set<string> = new Set(),
) {
    const { paths: systemTags, parentIds: systemParentIds } = await loadSystemTagIndex(tx);
    const systemByPath = new Map<string, string | null>();
    for (const [id, { subject, path }] of systemTags) {
        const pathKey = JSON.stringify([subject, path]);
        systemByPath.set(pathKey, systemByPath.has(pathKey) ? null : id);
    }

    function systemId(id: string, subject: string, name: string | null, path: unknown): string | undefined {
        const sameId = systemTags.get(id);
        if (sameId?.subject === subject && (!name || sameId.path.at(-1) === name)
            && (!Array.isArray(path) || JSON.stringify(sameId.path) === JSON.stringify(path))) return id;
        const candidate = Array.isArray(path)
            ? systemByPath.get(JSON.stringify([subject, path]))
            : undefined;
        if (candidate === null) ambiguousTag();
        return candidate;
    }

    const source = new Map(rows.map((row) => [row.id, row]));
    const mapped = new Map<string, string>();
    const visiting = new Set<string>();
    let created = 0;

    async function restore(row: BackupCustomTag): Promise<string> {
        const mappedId = mapped.get(row.id);
        if (mappedId) return mappedId;
        if (visiting.has(row.id)) ambiguousTag();
        visiting.add(row.id);

        let parentId: string | null = null;
        if (row.parentId) {
            const parent = source.get(row.parentId);
            if (parent && (parent.userId !== row.userId || parent.subject !== row.subject)) ambiguousTag();
            if (parent) {
                parentId = await restore(parent);
            } else if (row.systemParentPath !== undefined) {
                parentId = systemId(row.parentId, row.subject, null, row.systemParentPath) ?? ambiguousTag();
            } else {
                // 历史备份未携带 systemParentPath，跨库系统标签 ID 失效时降级为根级自定义标签
                const resolved = systemId(row.parentId, row.subject, null, undefined);
                if (resolved) {
                    parentId = resolved;
                } else {
                    parentId = null;
                    warnings.add('LEGACY_CUSTOM_TAG_PARENT_DETACHED');
                }
            }
        }
        const identity = { userId: row.userId, name: row.name, subject: row.subject, parentId, isSystem: false };
        const matches = await tx.knowledgeTag.findMany({ where: identity, select: { id: true } });
        const existing = matches.find((match) => match.id === row.id) ?? (matches.length === 1 ? matches[0] : null);
        if (!existing && matches.length > 1) ambiguousTag();
        const tag = existing ?? await tx.knowledgeTag.create({
            data: { ...identity, code: row.code, order: row.order },
            select: { id: true },
        });
        if (!existing) created++;
        mapped.set(row.id, tag.id);
        visiting.delete(row.id);
        return tag.id;
    }
    for (const row of rows) await restore(row);

    // 早期 JSON 备份有些引用只有名称，没有标签 ID、学科或完整路径。
    const legacyCandidates = new Map<string, { id: string; isSystem: boolean }[]>();
    async function connections(userId: string, refs: unknown): Promise<{ id: string }[]> {
        if (!Array.isArray(refs)) return [];
        const ids = new Set<string>();
        for (const rawRef of refs) {
            if (!rawRef || typeof rawRef !== 'object') continue;
            const ref = rawRef as Record<string, unknown>;
            if (typeof ref.name !== 'string') continue;
            const oldId = typeof ref.id === 'string' ? ref.id : '';
            const row = source.get(oldId);
            if (row) {
                if (row.userId !== userId) ambiguousTag();
                ids.add(mapped.get(row.id)!);
                continue;
            }

            if (Array.isArray(ref.systemPath)) {
                const subject = typeof ref.subject === 'string' ? ref.subject : '';
                const id = systemId(oldId, subject, ref.name, ref.systemPath);
                ids.add(id ?? ambiguousTag());
                continue;
            }
            const subject = typeof ref.subject === 'string' ? ref.subject : undefined;
            const isSystem = typeof ref.isSystem === 'boolean' ? ref.isSystem : undefined;
            const cacheKey = JSON.stringify([userId, subject, ref.name, isSystem]);
            let matches = legacyCandidates.get(cacheKey);
            if (!matches) {
                matches = await tx.knowledgeTag.findMany({
                    where: { name: ref.name, subject, isSystem, OR: [{ isSystem: true }, { userId }] },
                    select: { id: true, isSystem: true },
                });
                legacyCandidates.set(cacheKey, matches);
            }
            const exact = matches.find((tag) => tag.id === oldId);
            if (exact) {
                ids.add(exact.id);
                continue;
            }
            if (matches.length === 1) {
                ids.add(matches[0].id);
                continue;
            }
            if (matches.length > 1) {
                if (subject === undefined || !matches.every((tag) => tag.isSystem)) {
                    ambiguousTag();
                }
                // 同科历史系统标签重名时优先选非父节点叶子，否则按 ID 升序兜底
                const sorted = [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
                const picked = sorted.find((tag) => !systemParentIds.has(tag.id)) ?? sorted[0];
                ids.add(picked.id);
                warnings.add('LEGACY_SYSTEM_TAG_APPROXIMATED');
            }
        }
        return [...ids].map((id) => ({ id }));
    }
    return { created, connections, warnings };
}
