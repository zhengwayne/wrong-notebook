/**
 * 小程序里模型生成的文字（答案、解析、错因、参考答案）。
 * 0.1.2 起小程序正常显示这些字段（带“AI 生成”标识），默认原样返回。
 * MP_SHOW_GENERATED_TEXT=false 时回到 0.1.1 的做法：经小程序令牌（Bearer xjmp_）访问时把这些字段置空，
 * 作为运维开关（例如类目未就绪或需要临时下线时整体关闭）。网页端（Cookie 会话）不经过这里，响应完全不变。
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

/** 小程序是否返回生成类文字：默认返回，只有显式设为 false / 0 / off 才置空 */
export function isMiniProgramGeneratedTextEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
    const raw = (env.MP_SHOW_GENERATED_TEXT ?? '').trim().toLowerCase();
    return !['false', '0', 'off', 'no'].includes(raw);
}

/** 开关关闭时，小程序请求返回置空后的响应体；其余情况（含网页端）原样返回 */
export function mpSafeBody<T>(req: Request | null | undefined, body: T, env: Readonly<Record<string, string | undefined>> = process.env): T {
    if (isMiniProgramGeneratedTextEnabled(env)) return body;
    return isMiniProgramRequest(req) ? hideGeneratedText(body) : body;
}

/** 小程序不提供的生成类功能（如举一反三出新题）：小程序请求直接 403 */
export function rejectMiniProgramGeneration(req: Request | null | undefined): NextResponse | null {
    if (!isMiniProgramRequest(req)) return null;
    return NextResponse.json({ message: 'MP_FEATURE_UNAVAILABLE' }, { status: 403 });
}
