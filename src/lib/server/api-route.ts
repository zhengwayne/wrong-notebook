import type { z } from 'zod';
import { toConcurrencyErrorResponse } from '@/lib/ai/concurrency';
import {
    accountDisabled,
    badRequest,
    forbidden,
    kidModeRestricted,
    payloadTooLarge,
    sessionRevoked,
    unauthorized,
    validationError,
} from '@/lib/api-errors';
import { isAdmin } from '@/lib/auth-utils';
import { getKidModeLockFromRequest, isApiAllowedInKidMode } from '@/lib/kid-mode-lock';
import { resolveActor, type ActorUser } from '@/lib/server/actor';
import {
    createRequestContext,
    runWithRequestContext,
    setRequestContextKidModeLearnerId,
    setRequestContextUserId,
    type RequestContext,
} from '@/lib/server/request-context';
import type { Session } from 'next-auth';

export type ApiAuthLevel = 'public' | 'optional' | 'user' | 'admin';

export class PayloadTooLargeError extends Error {
    constructor() {
        super('Payload too large');
        this.name = 'PayloadTooLargeError';
    }
}

/**
 * 按实际读取字节数流式读取请求体（不信任客户端可伪造的 Content-Length 头），超限立即取消读取并抛错。
 */
export async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<string> {
    if (!request.body) {
        const text = await request.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new PayloadTooLargeError();
        }
        return text;
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                totalBytes += value.byteLength;
                if (totalBytes > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new PayloadTooLargeError();
                }
                chunks.push(value);
            }
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export interface RouteAuthPolicy<TSchema extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined> {
    auth: ApiAuthLevel;
    /** 少数历史上未登录也直接返回 403 的管理员接口可设此值保持测试与客户端契约一致 */
    unauthenticatedStatus?: 401 | 403;
    /** 可选请求体最大字节数（按实际流式读取字节计算，超限返回 413） */
    maxBodyBytes?: number;
    /** 可选请求 JSON Body Zod Schema（配置后自动解析并注入 ctx.body） */
    bodySchema?: TSchema;
}

type InferSchemaBody<TSchema> = TSchema extends z.ZodTypeAny ? z.infer<TSchema> : unknown;

export interface ApiRouteContext<TParams = Record<string, string>, TBody = unknown> {
    user: ActorUser | null;
    session: Session | null;
    requestContext: RequestContext;
    params: Promise<TParams>;
    body: TBody;
}

export interface AuthenticatedRouteContext<TParams = Record<string, string>, TBody = unknown>
    extends ApiRouteContext<TParams, TBody> {
    user: ActorUser;
    session: Session;
}

type NextRouteParams<TParams> = { params: Promise<TParams> };

export function defineApiRoute<
    TReq extends Request = Request,
    TParams = Record<string, string>,
    TSchema extends z.ZodTypeAny | undefined = undefined,
>(
    policy: RouteAuthPolicy<TSchema> & { auth: 'user' | 'admin' },
    handler: (
        req: TReq,
        ctx: AuthenticatedRouteContext<TParams, InferSchemaBody<TSchema>>,
    ) => Promise<Response> | Response,
): (req?: TReq, nextCtx?: NextRouteParams<TParams>) => Promise<Response>;

export function defineApiRoute<
    TReq extends Request = Request,
    TParams = Record<string, string>,
    TSchema extends z.ZodTypeAny | undefined = undefined,
>(
    policy: RouteAuthPolicy<TSchema> & { auth: 'public' | 'optional' },
    handler: (
        req: TReq,
        ctx: ApiRouteContext<TParams, InferSchemaBody<TSchema>>,
    ) => Promise<Response> | Response,
): (req?: TReq, nextCtx?: NextRouteParams<TParams>) => Promise<Response>;

/**
 * 统一 API 路由鉴权包装器：集中执行 Session 校验、DB 账户激活/会话撤销检查、角色判权、
 * 流式请求体字节上限拦截、JSON Schema 校验及 AsyncLocalStorage 请求上下文注入。
 */
export function defineApiRoute<
    TReq extends Request = Request,
    TParams = Record<string, string>,
    TSchema extends z.ZodTypeAny | undefined = undefined,
>(
    policy: RouteAuthPolicy<TSchema>,
    handler:
        | ((req: TReq, ctx: AuthenticatedRouteContext<TParams, InferSchemaBody<TSchema>>) => Promise<Response> | Response)
        | ((req: TReq, ctx: ApiRouteContext<TParams, InferSchemaBody<TSchema>>) => Promise<Response> | Response),
) {
    const invoke = handler as (
        req: TReq,
        ctx: ApiRouteContext<TParams, InferSchemaBody<TSchema>>,
    ) => Promise<Response> | Response;

    return async (req?: TReq, nextCtx?: NextRouteParams<TParams>): Promise<Response> => {
        const requestContext = createRequestContext(req);
        const params = nextCtx?.params ?? Promise.resolve({} as TParams);

        return runWithRequestContext(requestContext, async () => {
            let user: ActorUser | null = null;
            let session: Session | null = null;

            if (policy.auth !== 'public') {
                const actor = await resolveActor();

                if (policy.auth === 'optional') {
                    if (actor.kind === 'authenticated') {
                        user = actor.user;
                        session = actor.session;
                        setRequestContextUserId(actor.user.id);
                    }
                } else {
                    if (actor.kind === 'anonymous') {
                        if (policy.unauthenticatedStatus === 403) {
                            return forbidden('Admin access required');
                        }
                        return unauthorized();
                    }
                    if (actor.kind === 'revoked') {
                        return sessionRevoked('Session revoked');
                    }
                    if (actor.kind === 'disabled') {
                        return accountDisabled('Account is disabled');
                    }

                    if (policy.auth === 'admin' && !isAdmin(actor.user)) {
                        return forbidden('Admin access required');
                    }

                    user = actor.user;
                    session = actor.session;
                    setRequestContextUserId(actor.user.id);
                }

                if (user && req) {
                    const activeKidLock = getKidModeLockFromRequest(req, {
                        userId: user.id,
                        authVersion: user.authVersion,
                    });
                    if (activeKidLock) {
                        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
                        if (!isApiAllowedInKidMode(pathname, req.method)) {
                            return kidModeRestricted();
                        }
                        setRequestContextKidModeLearnerId(activeKidLock.learnerId);
                    }
                }
            }

            let effectiveReq = req as TReq;
            let parsedBody = undefined as InferSchemaBody<TSchema>;

            if (req && (policy.maxBodyBytes !== undefined || policy.bodySchema !== undefined)) {
                let rawText = '';
                try {
                    const maxBytes = policy.maxBodyBytes ?? Number.MAX_SAFE_INTEGER;
                    rawText = await readBodyWithinLimit(req, maxBytes);
                } catch (error) {
                    if (error instanceof PayloadTooLargeError) {
                        return payloadTooLarge();
                    }
                    return badRequest('Invalid request body');
                }

                if (policy.bodySchema) {
                    let jsonValue: unknown;
                    try {
                        jsonValue = rawText.length > 0 ? JSON.parse(rawText) : {};
                    } catch {
                        return badRequest('Invalid JSON body');
                    }
                    const validated = policy.bodySchema.safeParse(jsonValue);
                    if (!validated.success) {
                        return validationError('Invalid request body', validated.error.issues);
                    }
                    parsedBody = validated.data as InferSchemaBody<TSchema>;
                } else if (req.method !== 'GET' && req.method !== 'HEAD') {
                    // 未传 bodySchema 但启用了 maxBodyBytes 时，重放 Request 以便下游仍可读取 req.json()/text()
                    effectiveReq = new Request(req.url, {
                        method: req.method,
                        headers: req.headers,
                        body: rawText,
                    }) as TReq;
                }
            }

            try {
                return await invoke(effectiveReq, {
                    user,
                    session,
                    requestContext,
                    params,
                    body: parsedBody,
                });
            } catch (error) {
                const busy = toConcurrencyErrorResponse(error);
                if (busy) return busy;
                throw error;
            }
        });
    };
}
