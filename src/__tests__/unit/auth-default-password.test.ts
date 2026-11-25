/**
 * 默认密码检测：管理员用默认密码登录时会话带 mustChangePassword，改密后撤销旧会话并重新登录
 */
import { legacyAdminPasswordSample } from '../fixtures/legacy-admin';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JWT } from 'next-auth/jwt';
import type { User } from 'next-auth';

const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
    compare: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
vi.mock('@next-auth/prisma-adapter', () => ({ PrismaAdapter: vi.fn(() => ({})) }));
vi.mock('bcryptjs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('bcryptjs')>()),
    compare: mocks.compare,
}));
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import { authOptions } from '@/lib/auth';
import { isDefaultAdminPassword } from '@/lib/default-admin';

type AuthorizeFn = (credentials: Record<string, string>) => Promise<(User & { mustChangePassword?: boolean }) | null>;
const credentialsProvider = authOptions.providers[0] as unknown as { options: { authorize: AuthorizeFn } };
const authorize = (email: string, password: string) => credentialsProvider.options.authorize({ email, password });
const jwt = authOptions.callbacks!.jwt! as unknown as (params: { token: JWT; user?: User; trigger?: string; session?: object }) => Promise<JWT>;

const adminRow = { id: 'admin-1', email: 'admin@localhost', name: 'Admin', role: 'admin', isActive: true, password: 'hashed' };

describe('isDefaultAdminPassword', () => {
    it('仅匹配管理员使用的确切旧版口令', () => {
        expect(isDefaultAdminPassword('admin', legacyAdminPasswordSample)).toBe(true);
        expect(isDefaultAdminPassword('admin', 'another-pass')).toBe(false);
        expect(isDefaultAdminPassword('admin', 'other6')).toBe(false);
        expect(isDefaultAdminPassword('user', legacyAdminPasswordSample)).toBe(false);
        expect(isDefaultAdminPassword(undefined, legacyAdminPasswordSample)).toBe(false);
    });
});

describe('authorize 默认密码标记', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.compare.mockResolvedValue(true);
    });

    it('管理员用默认密码登录时标记必须改密', async () => {
        mocks.findUnique.mockResolvedValue(adminRow);

        const user = await authorize('admin@localhost', legacyAdminPasswordSample);

        expect(user?.mustChangePassword).toBe(true);
    });

    it('管理员用其他密码登录时不标记', async () => {
        mocks.findUnique.mockResolvedValue(adminRow);

        const user = await authorize('admin@localhost', 'my-new-pass');

        expect(user?.mustChangePassword).toBe(false);
    });

    it('普通用户使用旧版口令也不标记', async () => {
        mocks.findUnique.mockResolvedValue({ ...adminRow, role: 'user' });

        const user = await authorize('user@example.com', legacyAdminPasswordSample);

        expect(user?.mustChangePassword).toBe(false);
    });
});

describe('authorize 拒绝仅微信登录账号的占位邮箱', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 即使密码比对“通过”（例如有人猜中随机口令），占位邮箱也不能登录网页端
        mocks.compare.mockResolvedValue(true);
    });

    it('wechat.local 占位邮箱一律返回 null', async () => {
        const placeholder = 'wx_0123456789abcdef01234567@wechat.local';
        mocks.findUnique.mockResolvedValue({ ...adminRow, role: 'user', email: placeholder });
        expect(await authorize(placeholder, 'anything')).toBeNull();
        expect(await authorize(placeholder.toUpperCase(), 'anything')).toBeNull();
        expect(mocks.compare).not.toHaveBeenCalled();
    });
});

describe('jwt 回调', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('登录时把标记写入 token', async () => {
        const token = await jwt({ token: {} as JWT, user: { id: 'admin-1', role: 'admin', mustChangePassword: true } as User });

        expect(token.mustChangePassword).toBe(true);
    });

    it('普通会话更新保留强制改密标记，也忽略客户端提供的标记', async () => {
        mocks.findUnique.mockResolvedValue({ ...adminRow, authVersion: 0 });
        const token = { id: adminRow.id, authVersion: 0, mustChangePassword: true };
        expect((await jwt({ token, trigger: 'update' })).mustChangePassword).toBe(true);
        const updated = await jwt({ token, trigger: 'update', session: { user: { mustChangePassword: false } } });
        expect(updated.mustChangePassword).toBe(true);
        expect(mocks.compare).not.toHaveBeenCalled();
    });

    it('改密递增版本后撤销旧会话，新口令登录可解除强制改密', async () => {
        const bcrypt = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
        mocks.compare.mockImplementation((value: string, hash: string) => bcrypt.compare(value, hash));
        const oldRow = { ...adminRow, authVersion: 0, password: bcrypt.hashSync(legacyAdminPasswordSample, 4) };
        mocks.findUnique.mockResolvedValue(oldRow);
        const firstLogin = await authorize(oldRow.email, legacyAdminPasswordSample);
        expect(firstLogin).toBeTruthy();
        const oldToken = await jwt({ token: { id: oldRow.id }, user: firstLogin! });
        expect(oldToken.mustChangePassword).toBe(true);

        const newPassword = 'updated-password';
        mocks.findUnique.mockResolvedValue({ ...oldRow, authVersion: 1, password: bcrypt.hashSync(newPassword, 4) });
        expect((await jwt({ token: oldToken, trigger: 'update' })).revoked).toBe(true);
        expect(await authorize(oldRow.email, legacyAdminPasswordSample)).toBeNull();
        const newLogin = await authorize(oldRow.email, newPassword);
        expect(newLogin).toBeTruthy();
        const newToken = await jwt({ token: { id: oldRow.id }, user: newLogin! });
        expect(newToken).toMatchObject({ mustChangePassword: false, revoked: false, authVersion: 1 });
    });

    it('update 时即使无需改密也会刷新身份字段', async () => {
        mocks.findUnique.mockResolvedValue({
            personas: '["self"]',
            activePersona: 'self',
            personasConfirmedAt: new Date(),
        });

        const token = await jwt({ token: { id: 'user-1', mustChangePassword: false } as JWT, trigger: 'update' });

        expect(mocks.compare).not.toHaveBeenCalled();
        expect(token.mustChangePassword).toBe(false);
        expect(token.needsPersonaConfirmation).toBe(false);
        expect(token.activePersona).toBe('self');
    });
});
