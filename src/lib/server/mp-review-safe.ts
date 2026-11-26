/**
 * 小程序“只识别、不生成”模式：微信审核把展示 AI 生成文字（答案、解析、错因等）视为“深度合成-AI问答”。
 * 小程序只保留题目文字识别（OCR）与对错标记；经小程序令牌（Bearer xjmp_）访问时，
 * 这些接口的响应里把生成类文字字段置空。网页端（Cookie 会话）不经过这里，响应完全不变。
 */
import { NextResponse } from 'next/server';
import { readMiniProgramBearer } from '@/lib/server/mp-auth';

/** 由模型生成、小程序不展示的文字字段 */
export const MP_HIDDEN_GENERATED_FIELDS: ReadonlySet<string> = new Set([
    'answerText',
    'analysis',
    'mistakeAnalysis',
    'correctAnswer',
    'errorCause',
]);

export function isMiniProgramRequest(req?: Request | null): boolean {
    if (!req) return false;
    return readMiniProgramBearer(req.headers.get('authorization')) !== null;
}

/** 递归置空生成类字段：字符串变成 ''，其他值变成 null；不改原对象 */
export function hideGeneratedText<T>(value: T): T {
    if (Array.isArray(value)) return value.map((entry) => hideGeneratedText(entry)) as unknown as T;
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (MP_HIDDEN_GENERATED_FIELDS.has(key)) out[key] = typeof entry === 'string' ? '' : null;
        else out[key] = hideGeneratedText(entry);
    }
    return out as T;
}

/** 小程序请求返回置空后的响应体，网页端原样返回 */
export function mpSafeBody<T>(req: Request | null | undefined, body: T): T {
    return isMiniProgramRequest(req) ? hideGeneratedText(body) : body;
}

/** 小程序不提供的生成类功能（如举一反三出新题）：小程序请求直接 403 */
export function rejectMiniProgramGeneration(req: Request | null | undefined): NextResponse | null {
    if (!isMiniProgramRequest(req)) return null;
    return NextResponse.json({ message: 'MP_FEATURE_UNAVAILABLE' }, { status: 403 });
}
