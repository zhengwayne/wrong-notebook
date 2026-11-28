import { describe, expect, it } from 'vitest';
import { maskAccountName } from '@/lib/server/mp-web-handoff';

describe('确认页账号名脱敏', () => {
    it('保留首字，其余最多 3 个 *', () => {
        expect(maskAccountName('王老师')).toBe('王**');
        expect(maskAccountName('小雨妈妈今天')).toBe('小***');
        expect(maskAccountName('A')).toBe('A*');
        expect(maskAccountName('  ')).toBe('你的账号');
        expect(maskAccountName('😀ab')).toBe('😀**');
    });
});
