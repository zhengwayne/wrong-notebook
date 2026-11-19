import { describe, expect, it } from 'vitest';
import {
    readStoredTeacherScope,
    teacherScopeStorageKey,
    writeStoredTeacherScope,
} from '@/lib/current-child';

describe('教师班级/学生作用域持久化隔离', () => {
    it('按 userId 隔离存储与读取教师选定的班级与学生 learnerId', () => {
        const store = new Map<string, string>();
        const mockStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => { store.set(k, v); },
            removeItem: (k: string) => { store.delete(k); },
        };
        Object.defineProperty(globalThis, 'window', {
            value: { localStorage: mockStorage },
            configurable: true,
        });

        expect(teacherScopeStorageKey('t-1')).toBe('xueji.teacherLearnerScope:t-1');
        writeStoredTeacherScope({ classId: 'cls-1', learnerId: 'stu-l1', name: '李明' }, 't-1');
        writeStoredTeacherScope({ classId: 'cls-2', learnerId: null }, 't-2');

        expect(readStoredTeacherScope('t-1')).toEqual({
            classId: 'cls-1',
            learnerId: 'stu-l1',
            name: '李明',
        });
        expect(readStoredTeacherScope('t-2')).toEqual({
            classId: 'cls-2',
            learnerId: null,
        });

        writeStoredTeacherScope(null, 't-1');
        expect(readStoredTeacherScope('t-1')).toBeNull();
    });
});
