/**
 * 整页批改 › 每题详情（原生）：这道题裁出来的图、题目、孩子写的、参考答案和错因（带生成标识）、
 * 知识点、识别把握；确认前可以改判，已进错题本的题可跳到错题详情。
 * 文字来自 GET /api/parent/papers/:id?images=0，图来自 /questions/:qid/image（服务端按题框裁好）。
 */
import { loadContext } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { isVerdict, LOW_CONFIDENCE, PAPER_STATUS, type PaperDetail, type PaperQuestion, type Verdict, VERDICT_META, VERDICTS, verdictPatch } from '../../utils/paper';
import { toPlainText } from '../../utils/text';
import { PAGES } from '../../utils/nav';
import { markPaperChanged, percent, previewImage, safeImage } from '../../utils/detail';
import { GENERATED_LABEL } from '../../config';

const IMG = '?images=0';

interface QuestionView {
  id: string;
  number: string;
  question: string;
  studentAnswer: string;
  correctAnswer: string;
  errorCause: string;
  verdict: Verdict;
  verdictLabel: string;
  kps: string[];
  confidence: number;
  low: boolean;
  pageNo: number;
  importedId: string;
}

function toView(q: PaperQuestion): QuestionView {
  const verdict = isVerdict(q.effectiveVerdict) ? q.effectiveVerdict : 'wrong';
  return {
    id: q.id,
    number: q.number || String(q.position + 1),
    question: toPlainText(q.questionText) || '（题目见上方图片）',
    studentAnswer: toPlainText(q.studentAnswer) || '（没作答）',
    correctAnswer: toPlainText(q.correctAnswer),
    errorCause: toPlainText(q.errorCause),
    verdict,
    verdictLabel: VERDICT_META[verdict].label,
    kps: Array.isArray(q.knowledgePoints) ? q.knowledgePoints.filter(Boolean) : [],
    confidence: percent(q.confidence),
    low: q.overrideVerdict === null && q.confidence < LOW_CONFIDENCE,
    pageNo: (q.bbox?.pageIndex ?? 0) + 1,
    importedId: q.importedErrorItemId || '',
  };
}

Page({
  data: {
    paperId: '',
    questionId: '',
    q: null as QuestionView | null,
    title: '',
    pageCount: 0,
    editable: false,
    image: '',
    imageState: 'loading' as 'loading' | 'ok' | 'none',
    verdicts: VERDICTS.map((value) => ({ value, ...VERDICT_META[value] })),
    busy: false,
    generatedLabel: GENERATED_LABEL,
    error: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const paperId = query.paper ? decodeURIComponent(query.paper) : '';
    const questionId = query.q ? decodeURIComponent(query.q) : '';
    this.setData({ paperId, questionId });
    const ctx = await loadContext().catch(() => null);
    if (!ctx) return;
    if (ctx.kidMode) {
      this.setData({ error: '专注模式下不能看批改' });
      return;
    }
    void this.loadImage();
    try {
      this.applyPaper(await request<PaperDetail>(`/api/parent/papers/${encodeURIComponent(paperId)}${IMG}`));
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  applyPaper(paper: PaperDetail) {
    const question = paper.questions.find((item) => item.id === this.data.questionId);
    if (!question) {
      this.setData({ error: '这道题找不到了' });
      return;
    }
    const sameNumber = paper.questions.filter((item) => item.number === question.number).length > 1;
    const view = toView(question);
    this.setData({
      q: view,
      title: paper.title || '',
      pageCount: paper.pageCount,
      editable: paper.status === PAPER_STATUS.pendingConfirmation && !view.importedId,
    });
    wx.setNavigationBarTitle({ title: sameNumber ? `第 ${view.number} 题 · 第 ${view.pageNo} 页` : `第 ${view.number} 题` });
  },

  async loadImage() {
    try {
      const res = await request<{ imageUrl: string }>(`/api/parent/papers/${encodeURIComponent(this.data.paperId)}/questions/${encodeURIComponent(this.data.questionId)}/image`);
      const image = safeImage(res.imageUrl);
      this.setData({ image, imageState: image ? 'ok' : 'none' });
    } catch {
      this.setData({ imageState: 'none' });
    }
  },

  onPreviewImage() {
    previewImage(this.data.image);
  },

  async onVerdict(e: WechatMiniprogram.BaseEvent) {
    const q = this.data.q;
    const verdict = String(e.currentTarget.dataset.value);
    if (!q || !this.data.editable || this.data.busy || !isVerdict(verdict) || q.verdict === verdict) return;
    const before = q.verdict;
    this.setData({ busy: true, 'q.verdict': verdict, 'q.verdictLabel': VERDICT_META[verdict].label, 'q.low': false });
    try {
      const paper = await request<PaperDetail>(`/api/parent/papers/${encodeURIComponent(this.data.paperId)}/questions/${encodeURIComponent(q.id)}${IMG}`, {
        // wx.request 不支持 PATCH：服务端为同一接口提供了 POST 别名
        method: 'POST',
        data: verdictPatch(verdict),
      });
      markPaperChanged(this.data.paperId);
      this.applyPaper(paper);
    } catch (error) {
      this.setData({ 'q.verdict': before, 'q.verdictLabel': VERDICT_META[before].label });
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onOpenItem() {
    const id = this.data.q?.importedId;
    if (id) wx.navigateTo({ url: `${PAGES.xjDetail}?id=${encodeURIComponent(id)}` });
  },
});
