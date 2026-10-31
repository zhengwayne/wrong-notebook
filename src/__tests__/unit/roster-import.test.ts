/**
 * 名册导入：分隔符与表头识别、多班级、重复、错误、与已有名册比对
 */
import { describe, it, expect } from 'vitest';
import { parseRosterTable, planRosterImport, splitTable } from '@/lib/roster-import';

describe('splitTable / parseRosterTable', () => {
    it('带表头的 Excel 粘贴（制表符），列顺序任意', () => {
        const parsed = parseRosterTable(splitTable('姓名\t学号\t班级\n张三\t01\t七年级1班\n李四\t02\t七年级2班'));
        expect(parsed.hasHeader).toBe(true);
        expect(parsed.rows).toEqual([
            { line: 2, className: '七年级1班', studentNo: '01', name: '张三' },
            { line: 3, className: '七年级2班', studentNo: '02', name: '李四' },
        ]);
    });

    it('无表头的 CSV（含引号和全角逗号）按内容推断列', () => {
        const parsed = parseRosterTable(splitTable('七年级1班,01,张三\n"七年级1班"，02，"李,四"'));
        expect(parsed.hasHeader).toBe(false);
        expect(parsed.rows.map((row) => [row.className, row.studentNo, row.name])).toEqual([['七年级1班', '01', '张三'], ['七年级1班', '02', '李,四']]);
    });

    it('空格分隔、只有学号姓名时用默认班级', () => {
        const parsed = parseRosterTable(splitTable('01 张三\n02  李四\n'), '3班');
        expect(parsed.rows.map((row) => [row.className, row.studentNo, row.name])).toEqual([['3班', '01', '张三'], ['3班', '02', '李四']]);
    });

    it('只有姓名一列', () => {
        expect(parseRosterTable(splitTable('张三\n李四'), '1班').rows.map((row) => row.name)).toEqual(['张三', '李四']);
    });

    it('报告错误与重复', () => {
        const parsed = parseRosterTable(splitTable('班级,学号,姓名\n1班,01,张三\n1班,1,张三丰\n,03,王五\n1班,04,\n2班,01,赵六\n1班,0#5,钱七'));
        expect(parsed.rows.map((row) => row.name)).toEqual(['张三', '赵六', '钱七']);
        expect(parsed.duplicates).toEqual([{ line: 3, firstLine: 2, className: '1班', studentNo: '1', name: '张三丰' }]);
        expect(parsed.errors).toEqual([{ line: 4, code: 'missing_class' }, { line: 5, code: 'missing_name' }]);
        expect(parsed.rows[2].studentNo).toBe('05');
    });
});

describe('planRosterImport', () => {
    const existing = [
        { id: 's1', classId: 'c1', className: '1班', name: '张三', studentNo: '01' },
        { id: 's2', classId: 'c1', className: '1班', name: '李四', studentNo: null },
    ];

    it('同班同学号更新姓名、同名补学号、其余新增并新建班级', () => {
        const plan = planRosterImport([
            { line: 1, className: '1班', studentNo: '1', name: '张叁' },
            { line: 2, className: '1班', studentNo: '02', name: '李四' },
            { line: 3, className: '1班', studentNo: '03', name: '王五' },
            { line: 4, className: '2班', studentNo: '01', name: '赵六' },
        ], existing, ['1班']);
        expect(plan.rows.map((row) => [row.action, row.studentId])).toEqual([['update', 's1'], ['update', 's2'], ['create', null], ['create', null]]);
        expect(plan.rows[0].previousName).toBe('张三');
        expect(plan.newClasses).toEqual(['2班']);
        expect(plan.counts).toEqual({ create: 2, update: 2, unchanged: 0 });
    });

    it('完全相同的行不变', () => {
        const plan = planRosterImport([{ line: 1, className: '1班', studentNo: '01', name: '张三' }], existing, ['1班']);
        expect(plan.rows[0].action).toBe('unchanged');
    });
});
