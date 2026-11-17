/**
 * 管理员运营诊断指标聚合服务：
 * - 后台任务与异步作业状态分布（成功 / 失败 / 未知）
 * - AI 并发队列饱和度、上游 429 比例与排队耗时分位数
 * - SQLite 外键一致性检查状态（安全转换 BigInt）
 * - 按 AiProvenance 分组的人工修改 AI 识别结果比例
 */
import type { PrismaClient } from "@prisma/client";
import { getAiConcurrencyTelemetry, type AiConcurrencyTelemetrySnapshot } from "@/lib/ai/concurrency";
import { prisma } from "@/lib/prisma";

export interface TaskStatusBreakdown {
    total: number;
    succeeded: number;
    failed: number;
    unknown: number;
    inFlight: number;
    byStatus: Record<string, number>;
}

export interface ProvenanceQualityEntry {
    provenanceId: string;
    task: string;
    provider: string;
    model: string;
    promptVersion: string;
    parserVersion: string;
    totalCount: number;
    modifiedCount: number;
    manualModifiedRate: number;
    parentPaper: {
        totalCount: number;
        modifiedCount: number;
    };
    grading: {
        totalCount: number;
        modifiedCount: number;
    };
}

export interface OperationalMetricsSnapshot {
    generatedAt: string;
    tasks: {
        summary: {
            total: number;
            succeeded: number;
            failed: number;
            unknown: number;
            inFlight: number;
            successRate: number;
            failureRate: number;
            unknownRate: number;
        };
        parentPapers: TaskStatusBreakdown;
        gradingSubmissions: TaskStatusBreakdown;
        variantRuns: TaskStatusBreakdown;
        asyncOperations: {
            total: number;
            succeeded: number;
            failed: number;
            interrupted: number;
            running: number;
            unknown: number;
            successRate: number;
            failureRate: number;
            unknownRate: number;
            byStatus: Record<string, number>;
            byCategory: Record<string, Record<string, number>>;
        };
    };
    aiConcurrency: AiConcurrencyTelemetrySnapshot;
    foreignKeyCheck: {
        ok: boolean;
        violationCount: number;
        affectedTables: string[];
    };
    provenanceQuality: {
        totalReviewedItems: number;
        manualModifiedCount: number;
        manualModifiedRate: number;
        byProvenance: ProvenanceQualityEntry[];
    };
}

function roundRate(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    return Math.round((numerator / denominator) * 10000) / 10000;
}

function classifyStatusCounts(
    rows: Array<{ status: string; _count: { _all: number } }>,
    buckets: {
        succeeded: ReadonlySet<string>;
        failed: ReadonlySet<string>;
        inFlight: ReadonlySet<string>;
    },
): TaskStatusBreakdown {
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    let inFlight = 0;
    let unknown = 0;
    const byStatus: Record<string, number> = {};

    for (const row of rows) {
        const count = Number(row._count._all) || 0;
        total += count;
        byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
        if (buckets.succeeded.has(row.status)) {
            succeeded += count;
        } else if (buckets.failed.has(row.status)) {
            failed += count;
        } else if (buckets.inFlight.has(row.status)) {
            inFlight += count;
        } else {
            unknown += count;
        }
    }

    return { total, succeeded, failed, unknown, inFlight, byStatus };
}

interface RawForeignKeyRow {
    table: string;
    rowid: number | bigint;
    parent: string;
    fkid: number | bigint;
}

async function runForeignKeyCheck(db: PrismaClient): Promise<OperationalMetricsSnapshot["foreignKeyCheck"]> {
    const rows = await db.$queryRawUnsafe<RawForeignKeyRow[]>("PRAGMA foreign_key_check;");
    const affectedTables = Array.from(new Set(rows.map((row) => String(row.table))));
    return {
        ok: rows.length === 0,
        violationCount: rows.length,
        affectedTables,
    };
}

async function collectProvenanceQuality(
    db: PrismaClient,
): Promise<OperationalMetricsSnapshot["provenanceQuality"]> {
    const [paperGroups, gradingGroups] = await Promise.all([
        db.parentPaperQuestion.groupBy({
            by: ["provenanceId", "verdict", "overrideVerdict"],
            where: { provenanceId: { not: null } },
            _count: { _all: true },
        }),
        db.gradingResult.groupBy({
            by: ["provenanceId", "source"],
            where: { provenanceId: { not: null } },
            _count: { _all: true },
        }),
    ]);

    const statsById = new Map<
        string,
        {
            parentTotal: number;
            parentModified: number;
            gradingTotal: number;
            gradingModified: number;
        }
    >();

    const getOrCreate = (provenanceId: string) => {
        let entry = statsById.get(provenanceId);
        if (!entry) {
            entry = { parentTotal: 0, parentModified: 0, gradingTotal: 0, gradingModified: 0 };
            statsById.set(provenanceId, entry);
        }
        return entry;
    };

    for (const row of paperGroups) {
        if (!row.provenanceId) continue;
        const count = Number(row._count._all) || 0;
        const entry = getOrCreate(row.provenanceId);
        entry.parentTotal += count;
        if (row.overrideVerdict !== null && row.overrideVerdict !== row.verdict) {
            entry.parentModified += count;
        }
    }

    for (const row of gradingGroups) {
        if (!row.provenanceId) continue;
        const count = Number(row._count._all) || 0;
        const entry = getOrCreate(row.provenanceId);
        entry.gradingTotal += count;
        if (row.source === "teacher") {
            entry.gradingModified += count;
        }
    }

    const ids = Array.from(statsById.keys());
    const provenanceRecords = ids.length > 0
        ? await db.aiProvenance.findMany({
            where: { id: { in: ids } },
            select: {
                id: true,
                task: true,
                provider: true,
                model: true,
                promptVersion: true,
                parserVersion: true,
            },
        })
        : [];
    const provenanceMap = new Map(provenanceRecords.map((item) => [item.id, item]));

    let totalReviewedItems = 0;
    let manualModifiedCount = 0;

    const byProvenance: ProvenanceQualityEntry[] = ids.map((provenanceId) => {
        const counts = statsById.get(provenanceId)!;
        const meta = provenanceMap.get(provenanceId);
        const totalCount = counts.parentTotal + counts.gradingTotal;
        const modifiedCount = counts.parentModified + counts.gradingModified;
        totalReviewedItems += totalCount;
        manualModifiedCount += modifiedCount;

        return {
            provenanceId,
            task: meta?.task ?? "unknown",
            provider: meta?.provider ?? "unknown",
            model: meta?.model ?? "unknown",
            promptVersion: meta?.promptVersion ?? "unknown",
            parserVersion: meta?.parserVersion ?? "unknown",
            totalCount,
            modifiedCount,
            manualModifiedRate: roundRate(modifiedCount, totalCount),
            parentPaper: {
                totalCount: counts.parentTotal,
                modifiedCount: counts.parentModified,
            },
            grading: {
                totalCount: counts.gradingTotal,
                modifiedCount: counts.gradingModified,
            },
        };
    }).sort((a, b) => b.totalCount - a.totalCount || a.provenanceId.localeCompare(b.provenanceId));

    return {
        totalReviewedItems,
        manualModifiedCount,
        manualModifiedRate: roundRate(manualModifiedCount, totalReviewedItems),
        byProvenance,
    };
}

/** 采集系统运营诊断指标快照（任务状态、AI 并发、外键检查与溯源修改率） */
export async function collectOperationalMetrics(
    db: PrismaClient = prisma,
): Promise<OperationalMetricsSnapshot> {
    const [
        paperRows,
        gradingRows,
        variantRows,
        asyncRows,
        foreignKeyCheck,
        provenanceQuality,
    ] = await Promise.all([
        db.parentPaper.groupBy({ by: ["status"], _count: { _all: true } }),
        db.gradingSubmission.groupBy({ by: ["status"], _count: { _all: true } }),
        db.variantRun.groupBy({ by: ["status"], _count: { _all: true } }),
        db.asyncOperation.groupBy({ by: ["category", "status"], _count: { _all: true } }),
        runForeignKeyCheck(db),
        collectProvenanceQuality(db),
    ]);

    const parentPapers = classifyStatusCounts(paperRows, {
        succeeded: new Set(["pending_confirmation", "confirmed"]),
        failed: new Set(["failed"]),
        inFlight: new Set(["pending_recognition", "recognizing"]),
    });

    const gradingSubmissions = classifyStatusCounts(gradingRows, {
        succeeded: new Set(["graded", "confirmed"]),
        failed: new Set(["failed"]),
        inFlight: new Set(["pending", "grading"]),
    });

    const variantRuns = classifyStatusCounts(variantRows, {
        succeeded: new Set(["completed"]),
        failed: new Set(["failed"]),
        inFlight: new Set(["running"]),
    });

    const asyncByStatus: Record<string, number> = {};
    const asyncByCategory: Record<string, Record<string, number>> = {};
    let asyncTotal = 0;
    for (const row of asyncRows) {
        const count = Number(row._count._all) || 0;
        asyncTotal += count;
        asyncByStatus[row.status] = (asyncByStatus[row.status] ?? 0) + count;
        const categoryMap = asyncByCategory[row.category] ??= {};
        categoryMap[row.status] = (categoryMap[row.status] ?? 0) + count;
    }

    const asyncSucceeded = asyncByStatus.succeeded ?? 0;
    const asyncFailed = asyncByStatus.failed ?? 0;
    const asyncInterrupted = asyncByStatus.interrupted ?? 0;
    const asyncRunning = asyncByStatus.running ?? 0;
    const asyncOtherUnknown = Math.max(0, asyncTotal - asyncSucceeded - asyncFailed - asyncInterrupted - asyncRunning);
    const asyncUnknown = asyncInterrupted + asyncOtherUnknown;

    const succeeded = parentPapers.succeeded + gradingSubmissions.succeeded + variantRuns.succeeded;
    const failed = parentPapers.failed + gradingSubmissions.failed + variantRuns.failed;
    const inFlight = parentPapers.inFlight + gradingSubmissions.inFlight + variantRuns.inFlight;
    const unknown = parentPapers.unknown + gradingSubmissions.unknown + variantRuns.unknown + asyncUnknown;
    const total = succeeded + failed + inFlight + unknown;

    return {
        generatedAt: new Date().toISOString(),
        tasks: {
            summary: {
                total,
                succeeded,
                failed,
                unknown,
                inFlight,
                successRate: roundRate(succeeded, total),
                failureRate: roundRate(failed, total),
                unknownRate: roundRate(unknown, total),
            },
            parentPapers,
            gradingSubmissions,
            variantRuns,
            asyncOperations: {
                total: asyncTotal,
                succeeded: asyncSucceeded,
                failed: asyncFailed,
                interrupted: asyncInterrupted,
                running: asyncRunning,
                unknown: asyncUnknown,
                successRate: roundRate(asyncSucceeded, asyncTotal),
                failureRate: roundRate(asyncFailed, asyncTotal),
                unknownRate: roundRate(asyncUnknown, asyncTotal),
                byStatus: asyncByStatus,
                byCategory: asyncByCategory,
            },
        },
        aiConcurrency: getAiConcurrencyTelemetry(),
        foreignKeyCheck,
        provenanceQuality,
    };
}
