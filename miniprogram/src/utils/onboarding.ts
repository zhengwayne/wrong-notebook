/**
 * 新手引导（与网页端同一套进度，来自 GET /api/onboarding）。
 * 小程序只放文字与跳转：老师的步骤都在电脑上做，按钮给出一次性网页链接。
 */
import { request } from './request';

export type GuidePersona = 'teacher' | 'parent' | 'self';

export interface GuideStepData {
  key: string;
  done: boolean;
  meta?: Record<string, string | number | null>;
}

export interface GuideStatus {
  persona: GuidePersona;
  steps: GuideStepData[];
  doneCount: number;
  total: number;
  completed: boolean;
  completedAt: string | null;
  dismissedAt: string | null;
  visible: boolean;
  current: string | null;
}

/** 按钮做什么：web = 复制网页链接；page = 打开小程序页面 */
export type GuideAction =
  | { kind: 'web'; path: string }
  | { kind: 'page'; target: 'me' | 'capture' | 'review' | 'notebook' | 'parent' | 'grade'; id?: string };

interface StepCopy { title: string; desc: string; button: string; note?: (meta: Record<string, string | number | null>) => string }

interface PersonaCopy {
  title: string;
  steps: Record<string, StepCopy>;
  finish: { title: string; desc: string; button: string };
}

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export const GUIDE_COPY: Record<GuidePersona, PersonaCopy> = {
  teacher: {
    title: '四步开始改卷',
    steps: {
      class: { title: '建班级', desc: '导入名册：班级 · 学号 · 姓名', button: '在电脑上做', note: (m) => `${str(m.className)} · ${str(m.students)} 人` },
      task: { title: '新建改卷', desc: '填考试名称，录入答案', button: '在电脑上做', note: (m) => str(m.title) },
      collect: { title: '收卷', desc: '拍照、导入扫描件或扫码交', button: '在电脑上做', note: (m) => `${str(m.count)} 份答卷` },
      confirm: { title: '复核确认', desc: '核对得分，错题进学生错题本', button: '在电脑上做', note: (m) => `已确认 ${str(m.count)} 份` },
    },
    finish: { title: '看班级学情', desc: '共性薄弱点、每位学生的下一步', button: '去看' },
  },
  parent: {
    title: '四步用好错题本',
    steps: {
      child: { title: '添加孩子', desc: '先给孩子建个档', button: '去添加', note: (m) => str(m.name) },
      paper: { title: '拍一份卷子', desc: '整页拍，自动拆题', button: '去拍', note: () => '已拍' },
      confirm: { title: '核对后入错题本', desc: '改判、确认', button: '去核对', note: (m) => `${str(m.count)} 道错题` },
      review: { title: '每天复习', desc: '按计划出现在今日复习', button: '去复习', note: (m) => `已复习 ${str(m.count)} 次` },
    },
    finish: { title: '看看孩子的学情', desc: '薄弱点和今天该练什么', button: '去看' },
  },
  self: {
    title: '三步开始用错题本',
    steps: {
      capture: { title: '拍第一道错题', desc: '拍照存进错题本', button: '去拍', note: (m) => `${str(m.count)} 道` },
      collect: { title: '攒到 5 道', desc: '题越多，复习计划越准', button: '继续拍', note: (m) => `${str(m.count)}/${str(m.target)}` },
      review: { title: '完成一次复习', desc: '按计划出现在今日复习', button: '去复习', note: (m) => `已复习 ${str(m.count)} 次` },
    },
    finish: { title: '去错题本看看', desc: '按知识点整理好的错题', button: '去看' },
  },
};

export function isGuidePersona(value: unknown): value is GuidePersona {
  return value === 'teacher' || value === 'parent' || value === 'self';
}

/** 首页用哪个身份的引导：当前身份 → 第一个身份 → 自学 */
export function guidePersonaFor(user: { personas: string[]; activePersona: string | null }): GuidePersona {
  if (isGuidePersona(user.activePersona)) return user.activePersona;
  const first = user.personas.find(isGuidePersona);
  return first || 'self';
}

export function fetchGuide(persona: GuidePersona): Promise<GuideStatus> {
  return request<GuideStatus>('/api/onboarding', { query: { persona } });
}

export function setGuideVisible(persona: GuidePersona, visible: boolean): Promise<GuideStatus> {
  return request<GuideStatus>('/api/onboarding', { method: 'POST', data: { persona, action: visible ? 'reopen' : 'dismiss' } });
}

function meta(status: GuideStatus, key: string): Record<string, string | number | null> {
  const step = status.steps.find((s) => s.key === key);
  return (step && step.meta) || {};
}

/** 每一步按钮去哪（只用进度里带回的 id） */
export function guideAction(status: GuideStatus, key: string): GuideAction {
  if (status.persona === 'teacher') {
    const taskId = str(meta(status, 'collect').taskId) || str(meta(status, 'task').taskId);
    if (key === 'collect' && taskId) return { kind: 'web', path: `/grading/${taskId}` };
    if (key === 'confirm' && taskId) return { kind: 'web', path: `/grading/${taskId}/papers` };
    if (key === 'finish') return { kind: 'web', path: '/teacher' };
    return { kind: 'web', path: '/grading' };
  }
  if (status.persona === 'parent') {
    if (key === 'child') return { kind: 'page', target: 'me' };
    if (key === 'paper') return { kind: 'page', target: 'capture' };
    if (key === 'confirm') {
      const paperId = str(meta(status, 'confirm').paperId);
      return paperId ? { kind: 'page', target: 'grade', id: paperId } : { kind: 'page', target: 'capture' };
    }
    if (key === 'review') return { kind: 'page', target: 'review' };
    return { kind: 'page', target: 'parent' };
  }
  if (key === 'review') return { kind: 'page', target: 'review' };
  if (key === 'finish') return { kind: 'page', target: 'notebook' };
  return { kind: 'page', target: 'capture' };
}

export interface GuideStepView {
  key: string;
  index: number;
  title: string;
  desc: string;
  note: string;
  button: string;
  done: boolean;
  current: boolean;
  web: boolean;
}

export interface GuideView {
  persona: GuidePersona;
  title: string;
  subtitle: string;
  doneCount: number;
  total: number;
  percent: number;
  completed: boolean;
  steps: GuideStepView[];
  finish: { title: string; desc: string; button: string };
}

/** 进度 → 界面数据（纯函数，便于单测） */
export function buildGuideView(status: GuideStatus): GuideView {
  const copy = GUIDE_COPY[status.persona];
  const steps = status.steps.map((step, i) => {
    const c = copy.steps[step.key] || { title: step.key, desc: '', button: '去做' };
    const action = guideAction(status, step.key);
    return {
      key: step.key,
      index: i + 1,
      title: c.title,
      desc: c.desc,
      note: step.done && c.note ? c.note(step.meta || {}) : '',
      button: c.button,
      done: step.done,
      current: status.current === step.key,
      web: action.kind === 'web',
    };
  });
  return {
    persona: status.persona,
    title: status.completed ? '已经上手了' : copy.title,
    subtitle: status.completed
      ? '3 天后自动收起，可在「我的 › 新手引导」再打开'
      : status.persona === 'teacher' ? '进度和电脑端同步' : '按真实进度自动打勾',
    doneCount: status.doneCount,
    total: status.total,
    percent: Math.round((status.doneCount / Math.max(1, status.total)) * 100),
    completed: status.completed,
    steps,
    finish: copy.finish,
  };
}

/** 名册格式示例（复制到剪贴板，电脑上粘贴进 Excel 或名册框） */
export const ROSTER_EXAMPLE = '班级\t学号\t姓名\n七年级1班\t01\t张三\n七年级1班\t02\t李四';

export interface TeacherHomeClass {
  id: string;
  name: string;
  studentCount: number;
  latestTask: { id: string; title: string; createdAt: string; studentCount: number; submissionCount: number; confirmedCount: number } | null;
}

export interface CollectProgress { title: string; className: string; submitted: number; total: number; confirmed: number }

/** 老师首页「收卷进度」：取最近一次改卷（纯函数，便于单测） */
export function latestCollect(classes: TeacherHomeClass[]): CollectProgress | null {
  let best: TeacherHomeClass | null = null;
  for (const cls of classes) {
    if (!cls.latestTask) continue;
    if (!best || !best.latestTask || cls.latestTask.createdAt > best.latestTask.createdAt) best = cls;
  }
  if (!best || !best.latestTask) return null;
  const t = best.latestTask;
  return { title: t.title, className: best.name, submitted: t.submissionCount, total: t.studentCount, confirmed: t.confirmedCount };
}
