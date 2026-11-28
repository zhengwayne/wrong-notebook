/** 与后端接口对应的最小字段集合（只声明小程序用到的字段） */

export interface MpUser {
  id: string;
  /** 仅微信登录的账号为 null */
  email: string | null;
  /** true：只用微信登录，还没关联网页账号 */
  wechatOnly: boolean;
  name: string | null;
  role: string;
  personas: string[];
  activePersona: string | null;
  personasConfirmed: boolean;
}

export interface MpLoginResponse {
  status: 'ok';
  /** 本次登录自动新建了账号 */
  created?: boolean;
  token: string;
  expiresAt: string;
  user: MpUser;
}

export interface MpSessionResponse {
  user: MpUser;
  expiresAt: string;
  kidModeLearnerId: string | null;
}

export interface ChildLearner {
  id: string;
  name: string;
  itemCount: number;
}

export interface Notebook {
  id: string;
  name: string;
  _count?: { errorItems?: number };
}

export type MasteryStatus = 'new' | 'reviewing' | 'mastered';

export interface ErrorItemSummary {
  id: string;
  shortId?: string | null;
  questionText: string | null;
  knowledgePoints?: string | null;
  mistakeStatus?: string | null;
  masteryStatus?: MasteryStatus;
  createdAt: string;
  tags?: Array<{ name: string }>;
  reviewStage?: number;
  nextReviewAt?: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ErrorItemDetail extends ErrorItemSummary {
  answerText: string | null;
  analysis: string | null;
  wrongAnswerText?: string | null;
  mistakeAnalysis?: string | null;
  originalImageUrl?: string | null;
  learnerId?: string | null;
  subject?: { id: string; name: string } | null;
  userNotes?: string | null;
}

export interface AnalyzedQuestion {
  questionText: string;
  answerText: string;
  analysis: string;
  wrongAnswerText?: string;
  mistakeAnalysis?: string;
  mistakeStatus?: string;
  subject?: string;
  knowledgePoints?: string[];
  gradeSemester?: string | null;
  difficultyStars?: number | null;
  hasFigure?: boolean;
  figureSvg?: string | null;
}

export interface AnalyzeResponse extends AnalyzedQuestion {
  items: AnalyzedQuestion[];
  failedCount?: number;
  provenanceId?: string;
  /** 规范化后的原图；跨页题为几页拼好的一张 */
  imageDataUrl?: string;
  /** AI 判断：开头接着上一页 / 结尾没写完（用于提示合成一题） */
  continuity?: { startsMidQuestion: boolean; endsIncomplete: boolean };
  pageCount?: number;
}

export interface PracticeQuestion {
  questionText: string;
  answerText: string;
  analysis: string;
  subject?: string;
  pipeline?: boolean;
}

export interface ParentHomeResponse {
  children: ChildLearner[];
  selectedLearnerId: string | null;
  child: null | {
    id: string;
    name: string;
    weakPoints: Array<{ knowledgePoint: string; score: number; itemCount: number; unmasteredCount: number }>;
    today: Array<{ id?: string; title: string; reason: string; status: string; type: string }>;
    practiceTrend: Array<{ date: string; attempted: number; correct: number }>;
    practiceSummary: { attempted: number; correct: number };
    latestPaper: null | {
      id: string;
      title: string | null;
      status: string;
      questionCount: number;
      correctCount: number | null;
    };
  };
}

export interface KidModeStatus {
  active: boolean;
  learnerId: string | null;
  learnerName: string | null;
  hasPin: boolean;
  lockedUntil: string | null;
}
