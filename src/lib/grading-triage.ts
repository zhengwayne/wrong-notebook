export type ReviewBucket = "green" | "yellow";

export interface TriageSubmissionInput {
    studentId: string | null | undefined;
    matchStatus: string | null | undefined;
    matchConfidence: number | null | undefined;
    visualAlertsCount: number;
    hasUnverifiedKey?: boolean;
    results: ReadonlyArray<{
        type: "objective" | "subjective" | string;
        verdict: string;
        confidence?: number | null;
    }>;
}

/**
 * 红绿灯置信度分流：
 * 仅当学生身份已高把握绑定、无宏观视觉异常预警、标准答案均已固化且全卷均为高把握客观题时归入绿灯免检区；
 * 含主观题、未核验 AI 推导答案、漏读/缺失或低置信度、待人工核验身份的一律归入黄灯复核区。
 */
export function computeSubmissionBucket(input: TriageSubmissionInput): ReviewBucket {
    if (input.hasUnverifiedKey) return "yellow";
    if (!input.studentId || input.matchStatus === "review") return "yellow";
    const identityConfident = input.matchStatus === "manual" || (input.matchConfidence ?? 0) >= 0.9;
    if (!identityConfident) return "yellow";
    if (input.visualAlertsCount > 0) return "yellow";
    if (input.results.length === 0) return "yellow";

    for (const item of input.results) {
        if (item.type !== "objective") return "yellow";
        if (item.verdict === "partial") return "yellow";
        if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0.85) {
            return "yellow";
        }
    }
    return "green";
}
