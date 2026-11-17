/**
 * outbound-url 单元测试：验证 SSRF 黑名单、编码 IP 与本地 Ollama 局域网放行策略 (OPT-02)
 */
import { describe, expect, it, vi } from 'vitest';

const dnsMocks = vi.hoisted(() => ({
    lookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
    lookup: dnsMocks.lookup,
}));

import { assertSafeOutboundUrl, OutboundUrlError, resolveAndAssertSafeOutboundUrl } from '@/lib/outbound-url';

describe('outbound-url SSRF 校验', () => {
    it.each([
        'file:///etc/passwd',
        'ftp://example.com',
        'javascript:alert(1)',
        'not a url',
        'https://user:secret@api.openai.com/v1',
        'http://0.0.0.0:8080/v1',
        'http://0.1.2.3/',
        'http://[::]:8000/v1',
        'http://[0:0:0:0:0:0:0:0]/v1',
        'http://169.254.169.254/latest/meta-data',
        'http://2852039166/latest/meta-data', // 十进制整数编码的 169.254.169.254
        'http://0xa9fea9fe/latest/meta-data', // 十六进制编码的 169.254.169.254
        'http://[fe80::1]/v1',
        'http://[::ffff:169.254.169.254]/v1',
        'http://[::ffff:a9fe:a9fe]/v1',
        'http://100.100.100.200/latest/meta-data',
        'http://metadata.google.internal/computeMetadata/v1/',
    ])('拦截危险或不合法出站地址: %s', (unsafeUrl) => {
        expect(() => assertSafeOutboundUrl(unsafeUrl)).toThrow(OutboundUrlError);
    });

    it.each([
        ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1'],
        ['http://localhost:8000/v1', 'http://localhost:8000/v1'],
        ['http://[::1]:11434/v1', 'http://[::1]:11434/v1'],
        ['http://10.0.0.8:11434/v1', 'http://10.0.0.8:11434/v1'],
        ['http://192.168.1.50:11434/v1', 'http://192.168.1.50:11434/v1'],
        ['http://172.16.8.12:8080/v1', 'http://172.16.8.12:8080/v1'],
        ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ])('放行本地、局域网部署与公网 HTTPS 地址: %s', (input, expected) => {
        expect(assertSafeOutboundUrl(input)).toBe(expected);
    });

    it('域名解析到元数据或全零 IP 时被 resolveAndAssertSafeOutboundUrl 拒绝', async () => {
        dnsMocks.lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
        await expect(resolveAndAssertSafeOutboundUrl('https://rebind.example.com/v1')).rejects.toThrow(OutboundUrlError);

        dnsMocks.lookup.mockResolvedValueOnce([{ address: 'fe80::1', family: 6 }]);
        await expect(resolveAndAssertSafeOutboundUrl('https://rebind6.example.com/v1')).rejects.toThrow(OutboundUrlError);

        dnsMocks.lookup.mockResolvedValueOnce([{ address: '192.168.1.12', family: 4 }]);
        await expect(resolveAndAssertSafeOutboundUrl('http://ollama.lan.local:11434/v1')).resolves.toBe('http://ollama.lan.local:11434/v1');
    });
});
