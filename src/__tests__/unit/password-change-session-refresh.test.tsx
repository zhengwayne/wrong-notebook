// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    patch: vi.fn(),
    signIn: vi.fn(),
    update: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
    apiClient: {
        get: mocks.get,
        patch: mocks.patch,
    },
}));

vi.mock('next-auth/react', () => ({
    signIn: mocks.signIn,
    useSession: () => ({
        data: { user: { id: 'admin-1', email: 'setup-admin@localhost', role: 'admin' } },
        status: 'authenticated',
        update: mocks.update,
    }),
}));

vi.mock('@/lib/feedback', () => ({
    toast: {
        success: mocks.toastSuccess,
        error: mocks.toastError,
    },
}));

vi.mock('@/lib/frontend-logger', () => ({
    frontendLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/settings/account-persona-section', () => ({
    AccountPersonaSection: () => null,
}));

import { AccountSettings } from '@/components/settings/account-settings';
import { PasswordStep } from '@/components/setup/password-step';
import { LanguageProvider } from '@/contexts/LanguageContext';

function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('改密递增 authVersion 后的当前会话重签逻辑', () => {
    let container: HTMLDivElement;
    let root: Root;
    let reloadSpy: ReturnType<typeof vi.fn>;
    const originalLocation = window.location;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        reloadSpy = vi.fn();
        Object.defineProperty(window, 'location', {
            value: { ...originalLocation, reload: reloadSpy },
            configurable: true,
        });

        mocks.signIn.mockResolvedValue({ ok: true, error: null, status: 200, url: null });
        mocks.update.mockResolvedValue(null);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        document.body.innerHTML = '';
        Object.defineProperty(window, 'location', {
            value: originalLocation,
            configurable: true,
        });
        vi.unstubAllGlobals();
    });

    it('PasswordStep 修改默认密码后重签 credentials 会话再调用 update()，不触发自我吊销', async () => {
        mocks.patch.mockResolvedValueOnce({ email: 'setup-admin@localhost' });
        const onDone = vi.fn();

        await act(async () => {
            root.render(
                <LanguageProvider>
                    <PasswordStep onDone={onDone} />
                </LanguageProvider>,
            );
        });

        const newInput = container.querySelector('#setup-new-password') as HTMLInputElement;
        const confirmInput = container.querySelector('#setup-confirm-password') as HTMLInputElement;
        expect(newInput).not.toBeNull();
        expect(confirmInput).not.toBeNull();

        await act(async () => {
            setInputValue(newInput, 'setup-new-pass');
            setInputValue(confirmInput, 'setup-new-pass');
        });

        const form = container.querySelector('form') as HTMLFormElement;
        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.patch).toHaveBeenCalledWith('/api/user', { password: 'setup-new-pass' });
        expect(mocks.signIn).toHaveBeenCalledWith('credentials', {
            email: 'setup-admin@localhost',
            password: 'setup-new-pass',
            redirect: false,
        });
        expect(mocks.update).toHaveBeenCalledTimes(1);
        expect(mocks.signIn.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it('AccountSettings 修改密码时重签当前会话；仅修改姓名时不调用 signIn', async () => {
        const baseProfile = {
            name: 'Tester',
            email: 'tester@example.com',
            educationStage: 'junior_high',
            enrollmentYear: 2024,
        };
        mocks.get.mockResolvedValue(baseProfile);
        mocks.patch.mockResolvedValue({ ...baseProfile, name: 'Tester Renamed' });

        await act(async () => {
            root.render(
                <LanguageProvider>
                    <AccountSettings />
                </LanguageProvider>,
            );
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const submitButton = () => Array.from(container.querySelectorAll('button')).find((b) =>
            /更新|Update/.test(b.textContent || ''),
        )!;

        // 1. 仅修改姓名（不修改密码）时不应重签会话
        await act(async () => {
            submitButton().click();
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.patch).toHaveBeenCalledTimes(1);
        expect(mocks.signIn).not.toHaveBeenCalled();
        expect(reloadSpy).toHaveBeenCalledTimes(1);

        // 2. 填写新密码并确认保存时，重签 credentials 会话后再刷新页面
        const passwordInputs = container.querySelectorAll<HTMLInputElement>('input[placeholder="******"]');
        expect(passwordInputs.length).toBeGreaterThanOrEqual(1);
        await act(async () => {
            setInputValue(passwordInputs[0], 'new-secret-999');
        });
        const confirmInputs = container.querySelectorAll<HTMLInputElement>('input[placeholder="******"]');
        expect(confirmInputs.length).toBe(2);
        await act(async () => {
            setInputValue(confirmInputs[1], 'new-secret-999');
        });

        await act(async () => {
            submitButton().click();
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.patch).toHaveBeenCalledTimes(2);
        expect(mocks.signIn).toHaveBeenCalledWith('credentials', {
            email: 'tester@example.com',
            password: 'new-secret-999',
            redirect: false,
        });
        expect(reloadSpy).toHaveBeenCalledTimes(2);
    });
});
