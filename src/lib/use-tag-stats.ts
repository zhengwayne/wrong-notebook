import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import { frontendLogger } from "@/lib/frontend-logger";
import { useCurrentChild } from "@/lib/use-current-child";
import type { TagStats, TagStatsResponse } from "@/types/api";

/** 加载当前用户（或当前选定孩子）的知识点使用次数统计 */
export function useTagStats() {
    const { learnerId } = useCurrentChild();
    const [stats, setStats] = useState<TagStats[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        apiClient.get<TagStatsResponse>(withChildParam("/api/tags/stats", learnerId))
            .then((data) => {
                if (!cancelled) setStats(data.stats);
            })
            .catch((error) => {
                frontendLogger.error('[Tags]', 'Failed to fetch tag stats', { error });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [learnerId]);

    return { stats, loading };
}
