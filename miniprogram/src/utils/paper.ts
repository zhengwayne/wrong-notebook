/**
 * 整页批改：沿用网页端「家长批改试卷」同一套接口与模型（ParentPaper / ParentPaperQuestion）。
 * 拆出每一道题并判 正确 / 部分正确 / 错误；家长可逐题改判，确认后错误与部分正确的题进孩子的错题本，
 * 判对的题留在这份试卷记录里（网页端「家长 · 试卷」可看）。本文件只放纯逻辑，便于单测。
 */
import { SUBJECT_LABELS, NOTEBOOK_SUBJECTS, type NotebookSubject } from './subjects';

export type Verdict = 'correct' | 'partial' | 'wrong';
export const VERDICTS: Verdict[] = ['correct', 'partial', 'wrong'];

export const PAPER_STATUS = {
  pendingRecognition: 'pending_recognition',
  recognizing: 'recognizing',
  pendingConfirmation: 'pending_confirmation',
  confirmed: 'confirmed',
  failed: 'failed',
} as const;

/** 与网页端 LOW_CONFIDENCE_THRESHOLD 相同：低于它标「待核对」 */
export const LOW_CONFIDENCE = 0.7;

export interface PaperQuestion {
  id: string;
  position: number;
  number: string;
  type: 'objective' | 'subjective';
  questionText: string;
  studentAnswer: string;
  correctAnswer: string;
  verdict: Verdict;
  overrideVerdict: Verdict | null;
  effectiveVerdict: Verdict;
  confidence: number;
  errorCause: string | null;
  knowledgePoints: string[];
  bbox: { pageIndex: number } | null;
  subjectHint: string | null;
  importedErrorItemId: string | null;
  selected: boolean;
}

export interface PaperDetail {
  id: string;
  learnerId: string;
  learnerName: string;
  title: string | null;
  status: string;
  pageCount: number;
  questionCount: number;
  version?: number;
  errorMessage: string | null;
  questions: PaperQuestion[];
  importedNotebooks: Array<{ subjectId: string; subjectName: string; count: number }>;
}

export interface ConfirmResult {
  importedCount: number;
  importedNotebooks: Array<{ subjectId: string; subjectName: string; count: number }>;
  paper: PaperDetail;
}

/** 三态按钮的图标与文字（图标在 assets/icons 里生成，选中为白色） */
export const VERDICT_META: Record<Verdict, { label: string; icon: string; iconOn: string; cls: string }> = {
  correct: { label: '正确', icon: '/assets/icons/check-s.svg', iconOn: '/assets/icons/check-w.svg', cls: 'v-correct' },
  partial: { label: '部分正确', icon: '/assets/icons/contrast-o.svg', iconOn: '/assets/icons/contrast-w.svg', cls: 'v-partial' },
  wrong: { label: '错误', icon: '/assets/icons/x-d.svg', iconOn: '/assets/icons/x-w.svg', cls: 'v-wrong' },
};

export function isVerdict(value: unknown): value is Verdict {
  return value === 'correct' || value === 'partial' || value === 'wrong';
}

/**
 * 改判时一并设置「是否进错题本」：网页端改判后还要单独勾选导入，
 * 小程序只有三态按钮，所以 错误 / 部分正确 = 进错题本，正确 = 不进。
 */
export function verdictPatch(verdict: Verdict): { overrideVerdict: Verdict; selected: boolean } {
  return { overrideVerdict: verdict, selected: verdict !== 'correct' };
}

/** 确认时实际会进错题本的题（与服务端 confirmParentPaper 的筛选一致） */
export function willImport(question: Pick<PaperQuestion, 'effectiveVerdict' | 'selected' | 'importedErrorItemId'>): boolean {
  return question.selected && question.effectiveVerdict !== 'correct' && !question.importedErrorItemId;
}

export function countVerdicts(questions: Array<Pick<PaperQuestion, 'effectiveVerdict'>>): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { correct: 0, partial: 0, wrong: 0 };
  for (const question of questions) counts[question.effectiveVerdict] += 1;
  return counts;
}

/** 错题本名字里含学科名就当作试卷学科（帮 AI 判题）；「自动按学科归类」或认不出返回 undefined */
export function subjectKeyFromNotebookName(name: string | undefined | null): NotebookSubject | undefined {
  const text = (name || '').trim();
  if (!text) return undefined;
  return NOTEBOOK_SUBJECTS.find((subject) => text.indexOf(SUBJECT_LABELS[subject]) >= 0);
}

/** 试卷标题：孩子名 + 日期（与网页端默认用孩子名一致，再加日期便于在网页端列表里区分） */
export function defaultPaperTitle(learnerName: string, now: Date = new Date()): string {
  return `${learnerName || '孩子'} ${now.getMonth() + 1}月${now.getDate()}日`;
}

/** 识别轮询：已出结果 / 失败 / 还在识别 */
export function pollOutcome(status: string): 'ready' | 'failed' | 'confirmed' | 'waiting' {
  if (status === PAPER_STATUS.pendingConfirmation) return 'ready';
  if (status === PAPER_STATUS.confirmed) return 'confirmed';
  if (status === PAPER_STATUS.failed) return 'failed';
  return 'waiting';
}

/** 识别中的进度提示（整卷识别 + 复核通常 1～4 分钟） */
export function gradeProgressText(seconds: number): string {
  if (seconds < 20) return '在拆题…';
  if (seconds < 60) return '逐题判对错…';
  if (seconds < 150) return '复核拿不准的题…';
  return '题多，再等一下…';
}

// ---------- 从录题页带到批改页的照片（同一小程序实例内的内存交接，不落盘） ----------

export interface GradeDraft {
  learnerId: string;
  learnerName: string;
  subjectKey?: NotebookSubject;
  photos: Array<{ path: string; size: number }>;
}

let draft: GradeDraft | null = null;

export function setGradeDraft(next: GradeDraft): void {
  draft = next;
}

export function takeGradeDraft(): GradeDraft | null {
  const current = draft;
  draft = null;
  return current;
}
