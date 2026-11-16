import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn() } }));

import { truncatePlainPreview } from '@/lib/plain-preview';

describe('truncatePlainPreview', () => {
    it('去掉 ** 标记，并且不会把公式从中间切断', () => {
        const text = '1. **数量关系混淆**：题目中的 $1200 \\div 50 = 24\\text{ 个}$ 是零件总数。';
        const short = truncatePlainPreview(text, 30);
        expect(short).not.toContain('**');
        expect(short).not.toMatch(/\$1200[^$]*$/);
        expect(short).not.toContain('24\\te');
        // 截断发生在公式前，或包含完整公式
        if (short.includes('1200')) {
            expect(short).toMatch(/1200\s*÷\s*50\s*=\s*24/);
        }
    });

    it('短文本不去掉公式意义，只清理标记', () => {
        expect(truncatePlainPreview('点 $O$ 与 **半径**', 80)).toMatch(/点\s*O\s*与\s*半径/);
        expect(truncatePlainPreview('点 $O$ 与 **半径**', 80)).not.toContain('$');
        expect(truncatePlainPreview('点 $O$ 与 **半径**', 80)).not.toContain('**');
    });
});
