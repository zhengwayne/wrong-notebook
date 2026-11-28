/**
 * 小程序错题本学段与学科（src/utils/subjects.ts）必须和网页端 src/lib/notebook-scope.ts 一致：
 * 网页端新增学科或调整学段可选范围时，这里会提醒同步小程序。
 */
import { describe, expect, it } from 'vitest';
import * as web from '../../src/lib/notebook-scope';
import {
    DEFAULT_NOTEBOOK_STAGE, defaultNotebookName, NOTEBOOK_STAGES, NOTEBOOK_SUBJECTS, STAGE_SUBJECTS, SUBJECT_LABELS, subjectForStage,
} from '../src/utils/subjects';

describe('错题本学段与学科与网页端一致', () => {
    it('学段、学科、各学段可选学科、中文名、默认学段完全相同', () => {
        expect(NOTEBOOK_STAGES).toEqual([...web.NOTEBOOK_STAGES]);
        expect(NOTEBOOK_SUBJECTS).toEqual([...web.NOTEBOOK_SUBJECTS]);
        for (const stage of web.NOTEBOOK_STAGES) expect(STAGE_SUBJECTS[stage]).toEqual([...web.STAGE_SUBJECTS[stage]]);
        expect(SUBJECT_LABELS).toEqual(web.SUBJECT_DISPLAY_NAMES);
        expect(DEFAULT_NOTEBOOK_STAGE).toBe(web.DEFAULT_NOTEBOOK_STAGE);
    });

    it('小程序能选的组合都能通过服务端校验', () => {
        for (const stage of NOTEBOOK_STAGES) {
            for (const subject of STAGE_SUBJECTS[stage]) expect(web.isValidNotebookScope(stage, subject)).toBe(true);
        }
    });
});

describe('新建错题本', () => {
    it('换学段后学科不可选时改为第一个', () => {
        expect(subjectForStage('primary', 'physics')).toBe('math');
        expect(subjectForStage('junior_high', 'physics')).toBe('physics');
    });

    it('默认名称避开已有错题本', () => {
        expect(defaultNotebookName('junior_high', 'physics', ['数学', '英语'])).toBe('物理');
        expect(defaultNotebookName('junior_high', 'math', ['数学', '英语'])).toBe('初中数学');
        expect(defaultNotebookName('junior_high', 'math', ['数学', '初中数学'])).toBe('初中数学2');
    });
});
