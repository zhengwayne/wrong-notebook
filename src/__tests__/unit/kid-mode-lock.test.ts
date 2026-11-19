import { describe, expect, it } from 'vitest';
import {
    KID_MODE_COOKIE_NAME,
    buildKidModeClearCookie,
    buildKidModeSetCookie,
    isApiAllowedInKidMode,
    isKidModeAllowedPagePath,
    signKidModeToken,
    verifyKidModeToken,
} from '@/lib/kid-mode-lock';

describe('kid-mode-lock 签名锁与路由收敛纯函数', () => {
    const secret = 'unit-test-secret-key-for-kid-mode';
    const validPayload = {
        userId: 'user-parent-1',
        learnerId: 'child-1',
        learnerName: '小明',
        authVersion: 2,
        exp: Math.floor(Date.now() / 1000) + 3600,
    };

    it('正常签名后可验签还原，篡改载荷或签名立即拒绝', () => {
        const token = signKidModeToken(validPayload, secret);
        expect(verifyKidModeToken(token, { userId: 'user-parent-1', authVersion: 2 }, secret)).toEqual(validPayload);

        const [body, sig] = token.split('.');
        const tamperedBody = Buffer.from(
            JSON.stringify({ ...validPayload, learnerId: 'child-2' }),
            'utf8',
        ).toString('base64url');
        expect(verifyKidModeToken(`${tamperedBody}.${sig}`, undefined, secret)).toBeNull();
        expect(verifyKidModeToken(`${body}.invalid_signature`, undefined, secret)).toBeNull();
    });

    it('过期、userId 不一致或 authVersion 变更时拒绝验签', () => {
        const expired = signKidModeToken({ ...validPayload, exp: Math.floor(Date.now() / 1000) - 10 }, secret);
        expect(verifyKidModeToken(expired, undefined, secret)).toBeNull();

        const valid = signKidModeToken(validPayload, secret);
        expect(verifyKidModeToken(valid, { userId: 'another-user' }, secret)).toBeNull();
        expect(verifyKidModeToken(valid, { userId: 'user-parent-1', authVersion: 3 }, secret)).toBeNull();
    });

    it('Cookie 构造包含 HttpOnly、SameSite=Lax 并在 HTTPS 下附加 Secure', () => {
        const httpCookie = buildKidModeSetCookie('tok123', false, 7200);
        expect(httpCookie).toContain(`${KID_MODE_COOKIE_NAME}=tok123`);
        expect(httpCookie).toContain('HttpOnly');
        expect(httpCookie).toContain('SameSite=Lax');
        expect(httpCookie).toContain('Path=/');
        expect(httpCookie).not.toContain('Secure');

        const httpsCookie = buildKidModeSetCookie('tok123', true, 7200);
        expect(httpsCookie).toContain('Secure');

        const clearCookie = buildKidModeClearCookie(true);
        expect(clearCookie).toContain('Max-Age=0');
        expect(clearCookie).toContain('HttpOnly');
    });

    it('页面路由白名单仅放行专注学习/复习/练习与公开页', () => {
        expect(isKidModeAllowedPagePath('/learn')).toBe(true);
        expect(isKidModeAllowedPagePath('/review')).toBe(true);
        expect(isKidModeAllowedPagePath('/practice')).toBe(true);
        expect(isKidModeAllowedPagePath('/error-items/item-1')).toBe(true);
        expect(isKidModeAllowedPagePath('/login')).toBe(true);

        expect(isKidModeAllowedPagePath('/')).toBe(false);
        expect(isKidModeAllowedPagePath('/parent')).toBe(false);
        expect(isKidModeAllowedPagePath('/notebooks')).toBe(false);
        expect(isKidModeAllowedPagePath('/exams')).toBe(false);
        expect(isKidModeAllowedPagePath('/grading')).toBe(false);
        expect(isKidModeAllowedPagePath('/admin')).toBe(false);
    });

    it('API 白名单放行做题闭环与解锁，拦截删题、切号、系统设置与改 PIN', () => {
        expect(isApiAllowedInKidMode('/api/parent/kid-mode', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/parent/kid-mode/unlock', 'POST')).toBe(true);
        expect(isApiAllowedInKidMode('/api/learning-path', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/review/due', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/practice/generate', 'POST')).toBe(true);
        expect(isApiAllowedInKidMode('/api/practice/grade', 'POST')).toBe(true);
        expect(isApiAllowedInKidMode('/api/practice/record', 'POST')).toBe(true);
        expect(isApiAllowedInKidMode('/api/error-items/item-1', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/user', 'GET')).toBe(true);

        expect(isApiAllowedInKidMode('/api/user', 'DELETE')).toBe(false);
        expect(isApiAllowedInKidMode('/api/user', 'PATCH')).toBe(false);
        expect(isApiAllowedInKidMode('/api/error-items/item-1/delete', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/error-items/batch-delete', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/error-items/clear', 'DELETE')).toBe(false);
        expect(isApiAllowedInKidMode('/api/learners', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/persona', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/settings', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/parent/pin', 'POST')).toBe(false);
    });
});
