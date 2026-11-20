import { NextResponse } from "next/server";
import { internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { collectOperationalMetrics } from "@/lib/ops-metrics";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger("api:admin:metrics");

/** 获取管理员运营诊断指标（任务分布、AI 并发、外键一致性和溯源修改率） */
export const GET = defineApiRoute({ auth: "admin", unauthenticatedStatus: 403 }, async () => {
    try {
        const metrics = await collectOperationalMetrics();
        return NextResponse.json(metrics);
    } catch (error) {
        logger.error({ error }, "Failed to collect operational metrics");
        return internalError("Failed to collect operational metrics");
    }
});
