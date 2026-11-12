import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized } from "@/lib/api-errors";

function csvEscape(value: unknown): string {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** GET /api/variants/compare?format=csv 对比流水线与旧生成路径的正确率、知识点、难度、耗时和用量 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const format = new URL(req.url).searchParams.get('format');
    const runs = await prisma.variantRun.findMany({
        where: { userId: user.id, status: { not: 'running' } },
        orderBy: { startedAt: 'desc' },
        take: 100,
        include: { items: true },
    });
    const rows = runs.map((run) => {
        const items = run.items;
        const approved = items.filter((item) => item.status === 'approved').length;
        const verified = items.filter((item) => item.status === 'verified' || item.status === 'approved').length;
        const pending = items.filter((item) => item.status === 'pending_review').length;
        const rejected = items.filter((item) => item.status === 'rejected').length;
        const difficultyOk = items.filter((item) => item.difficultyConsistent).length;
        return {
            id: run.id,
            mode: run.mode,
            kind: run.kind,
            title: run.title,
            startedAt: run.startedAt,
            itemCount: items.length,
            verified,
            pending,
            rejected,
            approved,
            verifyRate: items.length ? Math.round((verified / items.length) * 100) : 0,
            difficultyMatchRate: items.length ? Math.round((difficultyOk / items.length) * 100) : 0,
            latencyMs: run.totalLatencyMs,
            totalTokens: run.totalTokens,
            cost: run.cost,
        };
    });
    const summary = {
        pipeline: rows.filter((row) => row.mode === 'pipeline'),
        legacy: rows.filter((row) => row.mode === 'legacy'),
    };
    const average = (list: typeof rows, field: 'verifyRate' | 'difficultyMatchRate' | 'latencyMs' | 'totalTokens' | 'cost') => {
        const values = list.map((row) => row[field]).filter((value): value is number => typeof value === 'number');
        if (values.length === 0) return null;
        return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
    };
    const payload = {
        runs: rows,
        totals: {
            pipeline: { count: summary.pipeline.length, verifyRate: average(summary.pipeline, 'verifyRate'), difficultyMatchRate: average(summary.pipeline, 'difficultyMatchRate'), latencyMs: average(summary.pipeline, 'latencyMs'), totalTokens: average(summary.pipeline, 'totalTokens'), cost: average(summary.pipeline, 'cost') },
            legacy: { count: summary.legacy.length, verifyRate: average(summary.legacy, 'verifyRate'), difficultyMatchRate: average(summary.legacy, 'difficultyMatchRate'), latencyMs: average(summary.legacy, 'latencyMs'), totalTokens: average(summary.legacy, 'totalTokens'), cost: average(summary.legacy, 'cost') },
        },
    };
    if (format === 'csv') {
        const header = ['id', 'mode', 'kind', 'title', 'startedAt', 'itemCount', 'verified', 'pending', 'rejected', 'approved', 'verifyRate', 'difficultyMatchRate', 'latencyMs', 'totalTokens', 'cost'];
        const lines = [header.join(','), ...rows.map((row) => header.map((key) => csvEscape(row[key as keyof typeof row])).join(','))];
        return new NextResponse(lines.join('\n'), {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="variant-comparison.csv"',
            },
        });
    }
    return NextResponse.json(payload);
}
