import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
    requestId: string;
    userId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** 为服务端请求构建轻量上下文（优先透传 X-Request-Id） */
export function createRequestContext(req?: Request): RequestContext {
    const headerId = req?.headers?.get('x-request-id')?.trim();
    const requestId = headerId || crypto.randomUUID();
    return { requestId };
}

/** 在 AsyncLocalStorage 上下文中执行回调，确保下游日志与工具可见 requestId/userId */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
    return requestContextStorage.run(context, fn);
}

/** 读取当前异步链路绑定的请求上下文 */
export function getRequestContext(): RequestContext | undefined {
    return requestContextStorage.getStore();
}

/** 在身份解析完成后记录当前请求关联的 userId */
export function setRequestContextUserId(userId: string): void {
    const store = requestContextStorage.getStore();
    if (store) {
        store.userId = userId;
    }
}
