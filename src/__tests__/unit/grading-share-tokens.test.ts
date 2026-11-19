import { describe, expect, it } from 'vitest';
import {
    buildMissingReminderCopy,
    checkPublicTokenRateLimit,
    generateShareToken,
    hashShareToken,
    resetPublicTokenRateLimitForTests,
    resolveRequestClientIp,
} from '@/lib/grading-share-tokens';

describe('grading-share-tokens 公开短链令牌、催交文案与限流', () => {
    it('生成 192-bit base64url 高熵令牌且仅以 SHA-256 十六进制摘要比对', () => {
        const { rawToken, tokenHash } = generateShareToken();
        expect(rawToken.length).toBeGreaterThanOrEqual(32);
        expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(tokenHash).not.toBe(rawToken);
        expect(hashShareToken(rawToken)).toBe(tokenHash);
        expect(hashShareToken('short')).toBe('');
    });

    it('生成温和得体的中英文未交名单催交文案', () => {
        const zhText = buildMissingReminderCopy({
            taskTitle: '第三单元随堂测',
            subjectName: '数学',
            missingNames: ['张小北', '李小南'],
            submitUrl: 'https://example.com/submit/abc',
            language: 'zh',
        });
        expect(zhText).toContain('第三单元随堂测');
        expect(zhText).toContain('2');
        expect(zhText).toContain('张小北、李小南');
        expect(zhText).toContain('https://example.com/submit/abc');

        const enText = buildMissingReminderCopy({
            taskTitle: 'Unit 3 Quiz',
            subjectName: 'Math',
            missingNames: ['Alice'],
            language: 'en',
        });
        expect(enText).toContain('Unit 3 Quiz');
        expect(enText).toContain('Alice');
    });

    it('滑动窗口限流超出配额后拒绝请求并返回剩余冷却毫秒数', () => {
        resetPublicTokenRateLimitForTests();
        expect(checkPublicTokenRateLimit('ip1:tok1', 2, 60_000).allowed).toBe(true);
        expect(checkPublicTokenRateLimit('ip1:tok1', 2, 60_000).allowed).toBe(true);
        const third = checkPublicTokenRateLimit('ip1:tok1', 2, 60_000);
        expect(third.allowed).toBe(false);
        expect(third.retryAfterMs).toBeGreaterThan(0);

        for (let i = 0; i < 2050; i += 1) {
            checkPublicTokenRateLimit(`flood-${i}`, 5, 60_000);
        }
        // 新键写入后内部桶数量受 2000 上限约束
        expect(checkPublicTokenRateLimit('flood-last', 5, 60_000).allowed).toBe(true);
    });

    it('resolveRequestClientIp 遵循 TRUST_PROXY 配置防止伪造 XFF 绕过限流', () => {
        const orig = process.env.TRUST_PROXY;
        try {
            delete process.env.TRUST_PROXY;
            const req = new Request('http://127.0.0.1/api/public/test', {
                headers: { 'x-forwarded-for': '203.0.113.9' },
            });
            expect(resolveRequestClientIp(req)).toBe('local');

            process.env.TRUST_PROXY = 'true';
            expect(resolveRequestClientIp(req)).toBe('203.0.113.9');
        } finally {
            if (orig === undefined) delete process.env.TRUST_PROXY;
            else process.env.TRUST_PROXY = orig;
        }
    });
});
