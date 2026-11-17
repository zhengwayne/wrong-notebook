// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient, setOnSessionRevokedForTest } from '@/lib/api-client';

describe('apiClient 协议与会话控制 (OPT-15)', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
        setOnSessionRevokedForTest(null);
    });

    afterEach(() => {
        setOnSessionRevokedForTest(null);
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('无 body 的 GET / DELETE 与 FormData 请求不附带 JSON Content-Type，有 JSON body 时附带', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

        await apiClient.get('/api/ping');
        await apiClient.delete('/api/item/1');
        const form = new FormData();
        form.append('k', 'v');
        await apiClient.post('/api/upload', { hello: 1 });
        await fetch('/api/raw', { method: 'POST', body: form });
        // 通过 request options 传 FormData（例如 apiClient.delete 或直接模拟）
        await apiClient.get('/api/with-form', { method: 'POST', body: form });

        const getHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        const delHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
        const jsonPostHeaders = fetchMock.mock.calls[2][1].headers as Record<string, string>;
        const formHeaders = fetchMock.mock.calls[4][1].headers as Record<string, string>;

        expect(getHeaders['Content-Type']).toBeUndefined();
        expect(delHeaders['Content-Type']).toBeUndefined();
        expect(jsonPostHeaders['Content-Type']).toBe('application/json');
        expect(formHeaders['Content-Type']).toBeUndefined();
    });

    it('204 响应返回空对象，200 非 JSON 抛协议错误，500 纯文本只读一次并透传文本', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        expect(await apiClient.delete('/api/empty')).toEqual({});

        const textSpy = vi.fn(async () => 'Gateway Bad Response <html>');
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: textSpy,
        } as unknown as Response);
        await expect(apiClient.get('/api/fail')).rejects.toMatchObject({
            status: 500,
            data: 'Gateway Bad Response <html>',
        });
        expect(textSpy).toHaveBeenCalledTimes(1);

        fetchMock.mockResolvedValueOnce(new Response('<html>login page</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        }));
        await expect(apiClient.get('/api/html-200')).rejects.toMatchObject({
            status: 200,
            code: 'INVALID_JSON_RESPONSE',
        });
    });

    it('合并外部 signal 与超时：外部取消不伪装为 408 超时，真实超时返回 408', async () => {
        vi.useFakeTimers();

        // 1. 外部 signal 取消
        fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
                reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
        }));
        const external = new AbortController();
        const abortedPromise = apiClient.get('/api/slow', { signal: external.signal, timeout: 5000 });
        external.abort(new DOMException('User cancelled', 'AbortError'));
        await expect(abortedPromise).rejects.toSatisfy((err: unknown) => !(err instanceof ApiError && err.status === 408));

        // 2. 超时触发
        fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
                reject(init.signal?.reason ?? new DOMException('Timeout', 'TimeoutError'));
            });
        }));
        const timeoutPromise = apiClient.get('/api/timeout', { timeout: 1000 });
        const assertion = expect(timeoutPromise).rejects.toMatchObject({
            status: 408,
            data: { message: 'AI_TIMEOUT_ERROR' },
        });
        await vi.advanceTimersByTimeAsync(1100);
        await assertion;
    });

    it('401 SESSION_REVOKED / ACCOUNT_DISABLED 在防抖窗口内只触发一次登出，普通 401 不触发', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
        const onRevoked = vi.fn();
        setOnSessionRevokedForTest(onRevoked);

        // 普通 401
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'need login' }), { status: 401 }));
        await expect(apiClient.get('/api/me')).rejects.toBeInstanceOf(ApiError);
        expect(onRevoked).not.toHaveBeenCalled();

        // 并发三次 401 SESSION_REVOKED / ACCOUNT_DISABLED 只触发 1 次
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), { status: 401 }));
        await Promise.allSettled([
            apiClient.get('/api/a'),
            apiClient.get('/api/b'),
            apiClient.get('/api/c'),
        ]);
        expect(onRevoked).toHaveBeenCalledTimes(1);
        expect(onRevoked).toHaveBeenCalledWith('SESSION_REVOKED');

        // 超过防抖窗口 3 秒后 ACCOUNT_DISABLED 可再次触发
        await vi.advanceTimersByTimeAsync(3100);
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'ACCOUNT_DISABLED' }), { status: 401 }));
        await expect(apiClient.get('/api/d')).rejects.toBeInstanceOf(ApiError);
        expect(onRevoked).toHaveBeenCalledTimes(2);
        expect(onRevoked).toHaveBeenLastCalledWith('ACCOUNT_DISABLED');
    });
});
