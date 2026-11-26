/**
 * 整页批改：照片 → 网页端同一套「家长批改试卷」接口拆题判对错 → 逐题改判（正确 / 部分正确 / 错误）→ 确认。
 * 错误与部分正确的题进孩子的错题本；判对的题留在试卷记录里（网页端「家长 · 试卷」可看、可继续改）。
 * 接口都带 ?images=0：只回文字，不回整页图片。
 */
import { loadContext } from '../../utils/context';
import { PAGES, switchTo } from '../../utils/nav';
import { ApiError, isLostResponse, request, toChineseMessage } from '../../utils/request';
import {
  type ConfirmResult,
  countVerdicts,
  defaultPaperTitle,
  gradeProgressText,
  isVerdict,
  LOW_CONFIDENCE,
  type PaperDetail,
  type PaperQuestion,
  pollOutcome,
  takeGradeDraft,
  type Verdict,
  VERDICT_META,
  VERDICTS,
  verdictPatch,
  willImport,
} from '../../utils/paper';
import { clearPendingPaper, markGradeFinished, savePendingPaper } from '../../utils/paper-store';
import { toPlainText } from '../../utils/text';

/** 每页压到这个以内再上传（服务端单页上限 3MB 字符） */
const PAGE_TARGET_BYTES = 700 * 1024;
const PAGE_MAX_BASE64 = 2.8 * 1024 * 1024;
const POLL_MS = 3000;
const POLL_MAX_MS = 10 * 60 * 1000;
const IMG = '?images=0';

type Step = 'upload' | 'recognizing' | 'review' | 'done' | 'failed';

interface Row {
  id: string;
  number: string;
  question: string;
  studentAnswer: string;
  correctAnswer: string;
  errorCause: string;
  verdict: Verdict;
  low: boolean;
  pageNo: number;
  imported: boolean;
  open: boolean;
}

let alive = false;
let timer: number | null = null;
let draftPhotos: Array<{ path: string; size: number }> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compress(path: string, quality: number, width: number): Promise<string> {
  return new Promise((resolve) => {
    wx.compressImage({ src: path, quality, compressedWidth: width, success: (res) => resolve(res.tempFilePath), fail: () => resolve(path) });
  });
}

function readBase64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: (res) => resolve(res.data as string), fail: reject });
  });
}

/** 照片转 data URL：大图先压一遍，仍超服务端单页上限就再压一遍 */
async function toPageDataUrl(photo: { path: string; size: number }): Promise<string> {
  let path = photo.size > PAGE_TARGET_BYTES ? await compress(photo.path, 75, 1600) : photo.path;
  let base64 = await readBase64(path);
  if (base64.length > PAGE_MAX_BASE64) {
    path = await compress(photo.path, 55, 1280);
    base64 = await readBase64(path);
  }
  if (base64.length > PAGE_MAX_BASE64) throw new Error('照片太大，换一张清楚但小一点的');
  return `data:image/jpeg;base64,${base64}`;
}

function toRow(question: PaperQuestion, open = false): Row {
  return {
    id: question.id,
    number: question.number || String(question.position + 1),
    question: toPlainText(question.questionText) || `第 ${question.number} 题`,
    studentAnswer: toPlainText(question.studentAnswer) || '（没作答）',
    correctAnswer: toPlainText(question.correctAnswer),
    errorCause: toPlainText(question.errorCause),
    verdict: isVerdict(question.effectiveVerdict) ? question.effectiveVerdict : 'wrong',
    low: question.overrideVerdict === null && question.confidence < LOW_CONFIDENCE,
    pageNo: (question.bbox?.pageIndex ?? 0) + 1,
    imported: Boolean(question.importedErrorItemId),
    open,
  };
}

function stopTimer(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

Page({
  data: {
    step: 'upload' as Step,
    learnerId: '',
    learnerName: '',
    subjectKey: '',
    paperId: '',
    version: 0,
    rows: [] as Row[],
    counts: { correct: 0, partial: 0, wrong: 0 } as Record<Verdict, number>,
    importCount: 0,
    importedCount: 0,
    notebookText: '',
    pageCount: 0,
    hasPhotos: false,
    verdicts: VERDICTS.map((value) => ({ value, ...VERDICT_META[value] })),
    elapsed: 0,
    progressText: '',
    busyId: '',
    confirming: false,
    error: '',
    retry: '' as '' | 'create' | 'recognize' | 'poll',
  },

  async onLoad(options: Record<string, string | undefined>) {
    alive = true;
    const ctx = await loadContext().catch(() => null);
    if (!ctx || ctx.kidMode) {
      wx.navigateBack();
      return;
    }
    if (options.id) {
      draftPhotos = [];
      this.setData({ paperId: options.id, step: 'recognizing', progressText: '读取上次的批改…' });
      await this.resume();
      return;
    }
    const draft = takeGradeDraft();
    if (!draft || !draft.photos.length) {
      wx.navigateBack();
      return;
    }
    draftPhotos = draft.photos;
    this.setData({
      learnerId: draft.learnerId,
      learnerName: draft.learnerName,
      subjectKey: draft.subjectKey || '',
      pageCount: draft.photos.length,
      hasPhotos: true,
    });
    await this.create();
  },

  onUnload() {
    alive = false;
    stopTimer();
  },

  // ---------- 上传并开始识别 ----------

  async create() {
    this.setData({ step: 'upload', error: '', retry: '', progressText: `上传 ${draftPhotos.length} 页…` });
    try {
      const pages: Array<{ imageUrl: string }> = [];
      for (const photo of draftPhotos) pages.push({ imageUrl: await toPageDataUrl(photo) });
      const paper = await request<PaperDetail>(`/api/parent/papers${IMG}`, {
        method: 'POST',
        data: {
          learnerId: this.data.learnerId,
          title: defaultPaperTitle(this.data.learnerName),
          ...(this.data.subjectKey ? { subjectKey: this.data.subjectKey } : {}),
          pages,
        },
        timeout: 120000,
      });
      this.setData({ paperId: paper.id });
      savePendingPaper({ id: paper.id, learnerId: this.data.learnerId });
      await this.recognize();
    } catch (error) {
      if (!alive) return;
      this.setData({ step: 'failed', error: error instanceof ApiError || isLostResponse(error) ? toChineseMessage(error) : (error as Error).message || '上传失败', retry: 'create' });
    }
  },

  async recognize() {
    this.setData({ step: 'recognizing', error: '', retry: '', progressText: gradeProgressText(0) });
    try {
      await request(`/api/parent/papers/${this.data.paperId}/recognize${IMG}`, { method: 'POST', data: { language: 'zh' } });
    } catch (error) {
      // 409：已经在识别（例如上次断网后重试）——直接等结果
      if (!(error instanceof ApiError && error.status === 409)) {
        if (!alive) return;
        this.setData({ step: 'failed', error: toChineseMessage(error), retry: 'recognize' });
        return;
      }
    }
    await this.poll();
  },

  async poll() {
    const started = Date.now();
    this.setData({ step: 'recognizing', error: '', retry: '', elapsed: 0 });
    stopTimer();
    timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      this.setData({ elapsed, progressText: gradeProgressText(elapsed) });
    }, 1000) as unknown as number;
    let misses = 0;
    while (alive && Date.now() - started < POLL_MAX_MS) {
      await sleep(POLL_MS);
      if (!alive) return;
      try {
        const paper = await request<PaperDetail>(`/api/parent/papers/${this.data.paperId}${IMG}`);
        misses = 0;
        const outcome = pollOutcome(paper.status);
        if (outcome === 'waiting') continue;
        stopTimer();
        if (outcome === 'failed') {
          this.setData({ step: 'failed', error: paper.errorMessage ? `没认出来：${paper.errorMessage}` : '没认出来', retry: 'recognize' });
          return;
        }
        this.applyPaper(paper);
        return;
      } catch (error) {
        // 偶尔断网不算失败，连续 5 次才停下来让人点重试
        misses += 1;
        if (misses >= 5 || (error instanceof ApiError && error.status === 404)) {
          stopTimer();
          if (error instanceof ApiError && error.status === 404) clearPendingPaper();
          this.setData({ step: 'failed', error: toChineseMessage(error), retry: error instanceof ApiError && error.status === 404 ? '' : 'poll' });
          return;
        }
      }
    }
    stopTimer();
    if (alive) this.setData({ step: 'failed', error: '识别时间太长，稍后点重试看看结果', retry: 'poll' });
  },

  async resume() {
    try {
      const paper = await request<PaperDetail>(`/api/parent/papers/${this.data.paperId}${IMG}`);
      this.setData({ learnerId: paper.learnerId, learnerName: paper.learnerName, pageCount: paper.pageCount });
      const outcome = pollOutcome(paper.status);
      if (outcome === 'waiting' && paper.status === 'pending_recognition') await this.recognize();
      else if (outcome === 'waiting') await this.poll();
      else if (outcome === 'failed') this.setData({ step: 'failed', error: paper.errorMessage || '上次没认出来', retry: 'recognize' });
      else this.applyPaper(paper);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) clearPendingPaper();
      this.setData({ step: 'failed', error: toChineseMessage(error), retry: error instanceof ApiError && error.status === 404 ? '' : 'poll' });
    }
  },

  onRetry() {
    const retry = this.data.retry;
    if (retry === 'create') void this.create();
    else if (retry === 'recognize') void this.recognize();
    else if (retry === 'poll') void this.resume();
  },

  // ---------- 核对 ----------

  applyPaper(paper: PaperDetail) {
    const openIds = new Set(this.data.rows.filter((row) => row.open).map((row) => row.id));
    const confirmed = paper.status === 'confirmed';
    const notebooks = paper.importedNotebooks || [];
    this.setData({
      step: confirmed ? 'done' : 'review',
      version: paper.version ?? 0,
      learnerName: paper.learnerName || this.data.learnerName,
      rows: paper.questions.map((question) => toRow(question, openIds.has(question.id))),
      counts: countVerdicts(paper.questions),
      importCount: paper.questions.filter(willImport).length,
      importedCount: notebooks.reduce((sum, item) => sum + item.count, 0),
      notebookText: notebooks.map((item) => `${item.subjectName} ${item.count}`).join(' · '),
      error: '',
      retry: '',
    });
    if (confirmed) {
      clearPendingPaper();
      markGradeFinished();
    }
  },

  onToggleOpen(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.rows[index];
    if (row) this.setData({ [`rows[${index}].open`]: !row.open });
  },

  onPreviewPage(e: WechatMiniprogram.BaseEvent) {
    const pageNo = Number(e.currentTarget.dataset.page);
    const urls = draftPhotos.map((photo) => photo.path);
    if (urls[pageNo - 1]) wx.previewImage({ urls, current: urls[pageNo - 1] });
  },

  async onVerdict(e: WechatMiniprogram.BaseEvent) {
    if (this.data.step !== 'review' || this.data.busyId || this.data.confirming) return;
    const index = Number(e.currentTarget.dataset.index);
    const verdict = String(e.currentTarget.dataset.value);
    const row = this.data.rows[index];
    if (!row || !isVerdict(verdict) || row.verdict === verdict) return;
    const before = row.verdict;
    // 先改界面，失败再改回去
    this.setData({ busyId: row.id, [`rows[${index}].verdict`]: verdict, [`rows[${index}].low`]: false });
    try {
      const paper = await request<PaperDetail>(`/api/parent/papers/${this.data.paperId}/questions/${row.id}${IMG}`, {
        // wx.request 不支持 PATCH：服务端为同一接口提供了 POST 别名
        method: 'POST',
        data: verdictPatch(verdict),
      });
      this.applyPaper(paper);
    } catch (error) {
      this.setData({ [`rows[${index}].verdict`]: before });
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ busyId: '' });
    }
  },

  async onConfirm() {
    if (this.data.confirming || this.data.busyId || this.data.step !== 'review') return;
    this.setData({ confirming: true });
    try {
      const result = await request<ConfirmResult>(`/api/parent/papers/${this.data.paperId}/confirm${IMG}`, {
        method: 'POST',
        data: { language: 'zh', expectedVersion: this.data.version },
        timeout: 120000,
      });
      this.applyPaper(result.paper);
      wx.showToast({ title: result.importedCount ? `${result.importedCount} 题进了错题本` : '已确认', icon: 'success' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // 别处（网页端）改过或已确认：刷新后再看
        try {
          this.applyPaper(await request<PaperDetail>(`/api/parent/papers/${this.data.paperId}${IMG}`));
        } catch {
          // 保留当前界面
        }
        wx.showToast({ title: (this.data.step as Step) === 'done' ? '已经确认过了' : '有改动，已刷新，请再确认', icon: 'none' });
      } else {
        wx.showToast({ title: toChineseMessage(error), icon: 'none' });
      }
    } finally {
      this.setData({ confirming: false });
    }
  },

  onOpenNotebook() {
    switchTo(PAGES.xjNotebook);
  },

  onAgain() {
    markGradeFinished();
    wx.navigateBack({ fail: () => wx.redirectTo({ url: PAGES.xjCapture }) });
  },
});
