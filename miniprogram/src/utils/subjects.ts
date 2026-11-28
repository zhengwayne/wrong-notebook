/**
 * 错题本的学段与学科：与网页端 src/lib/notebook-scope.ts 保持一致（miniprogram/tests/subjects.test.ts 会比对）。
 * 学段、学科只在新建错题本时选择，之后不可修改。
 */

export type NotebookStage = 'primary' | 'junior_high' | 'senior_high';
export type NotebookSubject =
  | 'math' | 'english' | 'chinese' | 'physics' | 'chemistry' | 'biology' | 'history' | 'geography' | 'politics';

export const NOTEBOOK_STAGES: NotebookStage[] = ['primary', 'junior_high', 'senior_high'];
export const DEFAULT_NOTEBOOK_STAGE: NotebookStage = 'primary';

export const NOTEBOOK_SUBJECTS: NotebookSubject[] = [
  'math', 'english', 'chinese', 'physics', 'chemistry', 'biology', 'history', 'geography', 'politics',
];

/** 各学段可选的学科：只列出标签库中有该学段知识点的学科（小学只有数学、英语、语文） */
export const STAGE_SUBJECTS: Record<NotebookStage, NotebookSubject[]> = {
  primary: ['math', 'english', 'chinese'],
  junior_high: NOTEBOOK_SUBJECTS,
  senior_high: NOTEBOOK_SUBJECTS,
};

export const STAGE_LABELS: Record<NotebookStage, string> = {
  primary: '小学',
  junior_high: '初中',
  senior_high: '高中',
};

export const SUBJECT_LABELS: Record<NotebookSubject, string> = {
  math: '数学', english: '英语', chinese: '语文', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '政治',
};

/** 换学段后原学科不可选时，改为该学段的第一个学科 */
export function subjectForStage(stage: NotebookStage, subject: NotebookSubject): NotebookSubject {
  return STAGE_SUBJECTS[stage].indexOf(subject) >= 0 ? subject : STAGE_SUBJECTS[stage][0];
}

/** 新错题本的默认名称：学科名；已有同名的加上学段（如「初中数学」），再重名加序号 */
export function defaultNotebookName(stage: NotebookStage, subject: NotebookSubject, existing: string[]): string {
  const taken = (name: string) => existing.indexOf(name) >= 0;
  const base = SUBJECT_LABELS[subject];
  if (!taken(base)) return base;
  const staged = STAGE_LABELS[stage] + base;
  if (!taken(staged)) return staged;
  let n = 2;
  while (taken(`${staged}${n}`)) n += 1;
  return `${staged}${n}`;
}
