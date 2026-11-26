/**
 * 路由测试用的 @/lib/ai-quota 替身：consume(user, kind, options) 返回 null（放行）或 429 响应，
 * 包装成 reserveAiQuota 的预留句柄；结算均为空操作。
 */
type Consume = (...args: unknown[]) => Promise<Response | null> | Response | null;

export function quotaHandle(limited: Response | null) {
    const noop = async () => {};
    return {
        limited,
        id: null,
        reused: false,
        confirm: noop,
        release: noop,
        settle: noop,
        settleResponse: async <T,>(response: T) => response,
        attach: noop,
    };
}

export function createAiQuotaMock(consume: Consume) {
    return {
        reserveAiQuota: async (...args: unknown[]) => quotaHandle((await consume(...args)) ?? null),
        runWithAiQuota: async (_quota: unknown, run: () => Promise<unknown>) => run(),
        settleAiReservationsByRef: async () => {},
        confirmAiReservation: async () => {},
        releaseAiReservation: async () => {},
        aiQuotaRefs: {
            gradingSubmission: (id: string) => `grading-submission:${id}`,
            examPaper: (id: string) => `exam-paper:${id}`,
            variantRun: (id: string) => `variant-run:${id}`,
        },
    };
}
