/**
 * 答卷匹配字段的 JSON 解析（服务端返回给前端前使用）
 */
import { z } from "zod";
import type { MatchCandidate, MatchReasonCode } from "@/lib/student-match";

const reasonSchema = z.object({ code: z.string(), studentNoUnmatched: z.boolean().optional() });
const candidatesSchema = z.array(z.object({ studentId: z.string(), confidence: z.number(), reason: z.string() }));

export interface MatchReasonInfo { code: MatchReasonCode; studentNoUnmatched?: boolean }

function parse<T>(value: string | null | undefined, schema: z.ZodType<T>): T | null {
    if (!value) return null;
    try {
        const result = schema.safeParse(JSON.parse(value));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export function parseMatchReason(value: string | null | undefined): MatchReasonInfo | null {
    return parse(value, reasonSchema) as MatchReasonInfo | null;
}

export function parseCandidates(value: string | null | undefined): MatchCandidate[] {
    return (parse(value, candidatesSchema) || []) as MatchCandidate[];
}
