import { describe, expect, it } from 'vitest';
import { buildClassMasteryMatrix } from '@/lib/class-mastery-matrix';

describe('buildClassMasteryMatrix 班级「学生 × 知识点」热力矩阵聚合', () => {
    it('按涉及学生数降序和平均掌握度升序选取高频薄弱列，并对齐每位学生的掌握度与习惯评价', () => {
        const matrix = buildClassMasteryMatrix({
            students: [
                { studentId: 's1', name: '李四', studentNo: '01' },
                { studentId: 's2', name: '王五', studentNo: '02' },
            ],
            masteryByStudent: new Map([
                [
                    's1',
                    new Map([
                        ['一元一次方程', 0.35],
                        ['有理数加减', 0.85],
                        ['（未标注知识点）', 0.2],
                    ]),
                ],
                [
                    's2',
                    new Map([
                        ['一元一次方程', 0.45],
                        ['整式化简', 0.6],
                    ]),
                ],
            ]),
            habitsByStudent: new Map([
                ['s1', { handwritingLevel: 'good', attitudeLevel: 'excellent' }],
                ['s2', { handwritingLevel: 'needs_work', attitudeLevel: 'fair' }],
            ]),
            maxColumns: 5,
        });

        expect(matrix.knowledgePoints).toEqual(['一元一次方程', '整式化简', '有理数加减']);
        expect(matrix.rows).toEqual([
            {
                studentId: 's1',
                name: '李四',
                studentNo: '01',
                cells: [0.35, null, 0.85],
                handwritingLevel: 'good',
                attitudeLevel: 'excellent',
            },
            {
                studentId: 's2',
                name: '王五',
                studentNo: '02',
                cells: [0.45, 0.6, null],
                handwritingLevel: 'needs_work',
                attitudeLevel: 'fair',
            },
        ]);
    });
});
