/**
 * 答卷身份匹配：班级+学号、学号、姓名（含错字）、冲突、歧义、重复
 */
import { describe, it, expect } from 'vitest';
import {
    classRelation, flagDuplicate, identityKey, matchStudent, nameSimilarity, normalizeStudentNo,
    parseClassKey, studentNoEqual, type RosterStudent,
} from '@/lib/student-match';

const roster: RosterStudent[] = [
    { id: 'a1', name: '张三', studentNo: '01', classId: 'c1', className: '七年级(1)班' },
    { id: 'a2', name: '李晓明', studentNo: '02', classId: 'c1', className: '七年级(1)班' },
    { id: 'a3', name: '王芳', studentNo: '03', classId: 'c1', className: '七年级(1)班' },
    { id: 'b1', name: '张三', studentNo: '01', classId: 'c2', className: '七年级(2)班' },
    { id: 'b2', name: '陈静', studentNo: '15', classId: 'c2', className: '七年级(2)班' },
    { id: 'b3', name: '刘洋', studentNo: null, classId: 'c2', className: '七年级(2)班' },
];

describe('归一化', () => {
    it('学号全角、字母误读与前导零', () => {
        expect(normalizeStudentNo('０１２')).toBe('012');
        expect(normalizeStudentNo('O1S')).toBe('015');
        expect(normalizeStudentNo('A-12')).toBe('A12');
        expect(studentNoEqual('7', '07')).toBe(true);
        expect(studentNoEqual('', '07')).toBe(false);
    });
    it('班级写法', () => {
        expect(parseClassKey('七年级(3)班')).toMatchObject({ grade: 7, cls: 3 });
        expect(parseClassKey('初一3班')).toMatchObject({ grade: 7, cls: 3 });
        expect(parseClassKey('高二（十二）班')).toMatchObject({ grade: 11, cls: 12 });
        expect(parseClassKey('703')).toMatchObject({ grade: 7, cls: 3 });
        expect(classRelation('初一1班', '七年级(1)班')).toBe('match');
        expect(classRelation('1班', '七年级(1)班')).toBe('match');
        expect(classRelation('2班', '七年级(1)班')).toBe('mismatch');
        expect(classRelation('', '七年级(1)班')).toBe('unknown');
    });
    it('形近字相似度高于普通错字', () => {
        expect(nameSimilarity('李晓明', '李晓明')).toBe(1);
        expect(nameSimilarity('李哓明', '李晓明')).toBeGreaterThan(nameSimilarity('李小明', '李晓明'));
        expect(nameSimilarity('', '李晓明')).toBe(0);
    });
});

describe('matchStudent', () => {
    it('班级+学号精确匹配', () => {
        const result = matchStudent({ className: '七年级2班', studentNo: '1', name: '张三' }, roster);
        expect(result).toMatchObject({ status: 'matched', studentId: 'b1', reason: 'class_no' });
        expect(result.confidence).toBeGreaterThan(0.95);
    });

    it('缺班级时学号重复，用姓名区分；仍分不开则待确认', () => {
        expect(matchStudent({ studentNo: '15' }, roster)).toMatchObject({ status: 'matched', studentId: 'b2', reason: 'no_only' });
        expect(matchStudent({ studentNo: '01', name: '张三' }, roster)).toMatchObject({ status: 'review', reason: 'ambiguous' });
        expect(matchStudent({ studentNo: '01' }, roster).candidates.map((c) => c.studentId).sort()).toEqual(['a1', 'b1']);
    });

    it('只有姓名：唯一同名自动匹配，不同班同名需要班级', () => {
        expect(matchStudent({ name: '王芳' }, roster)).toMatchObject({ status: 'matched', studentId: 'a3', reason: 'name' });
        expect(matchStudent({ name: '张三' }, roster)).toMatchObject({ status: 'review', reason: 'ambiguous', studentId: null });
        expect(matchStudent({ name: '张三', className: '1班' }, roster)).toMatchObject({ status: 'matched', studentId: 'a1' });
    });

    it('识别错字：形近字加班级可自动匹配，否则给候选待确认', () => {
        expect(matchStudent({ name: '李哓明', className: '七年级1班' }, roster)).toMatchObject({ status: 'matched', studentId: 'a2', reason: 'name_fuzzy' });
        const loose = matchStudent({ name: '李小明' }, roster);
        expect(loose).toMatchObject({ status: 'review', studentId: null });
        expect(loose.candidates[0].studentId).toBe('a2');
    });

    it('学号指向一人、姓名指向另一人时待确认', () => {
        const result = matchStudent({ className: '七年级1班', studentNo: '03', name: '李晓明' }, roster);
        expect(result).toMatchObject({ status: 'review', reason: 'conflict', studentId: null });
        expect(result.candidates.map((c) => c.studentId)).toEqual(['a3', 'a2']);
    });

    it('学号对但姓名完全对不上时待确认', () => {
        expect(matchStudent({ className: '七年级1班', studentNo: '03', name: '赵钱孙' }, roster)).toMatchObject({ status: 'review', reason: 'name_mismatch' });
    });

    it('学号只在其他班存在时待确认', () => {
        expect(matchStudent({ className: '七年级1班', studentNo: '15' }, roster)).toMatchObject({ status: 'review', reason: 'class_mismatch' });
    });

    it('填了学号但名册里没有，姓名一致也降为待确认', () => {
        const result = matchStudent({ studentNo: '99', name: '王芳' }, roster);
        expect(result.status).toBe('review');
        expect(result.studentNoUnmatched).toBe(true);
        expect(result.candidates[0].studentId).toBe('a3');
    });

    it('缺字段：没有名册中的人或没有任何身份', () => {
        expect(matchStudent({}, roster)).toMatchObject({ status: 'review', reason: 'no_identity', candidates: [] });
        expect(matchStudent({ className: '3班' }, roster)).toMatchObject({ reason: 'no_identity' });
        expect(matchStudent({ name: '欧阳娜娜' }, roster)).toMatchObject({ status: 'review', reason: 'not_found' });
        expect(matchStudent({ name: '刘洋' }, roster)).toMatchObject({ status: 'matched', studentId: 'b3' });
    });
});

describe('flagDuplicate / identityKey', () => {
    it('已有答卷的学生改为待确认', () => {
        const matched = matchStudent({ name: '王芳' }, roster);
        expect(flagDuplicate(matched, new Set(['a3']))).toMatchObject({ status: 'review', reason: 'duplicate', studentId: null });
        expect(flagDuplicate(matched, new Set(['a1']))).toBe(matched);
    });
    it('身份键忽略写法差异', () => {
        expect(identityKey({ name: '张 三', studentNo: '07' })).toBe(identityKey({ name: '张三', studentNo: '7' }));
        expect(identityKey({}, null)).toBeNull();
        expect(identityKey({ name: 'x' }, 's1')).toBe('s:s1');
    });
});
