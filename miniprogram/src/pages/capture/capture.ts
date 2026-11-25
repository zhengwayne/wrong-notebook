import { currentLearnerId, loadContext } from '../../utils/context';
import { request, toChineseMessage, uploadImage } from '../../utils/request';
import { toPlainText } from '../../utils/text';
import type { AnalyzeResponse, AnalyzedQuestion, Notebook } from '../../utils/types';

interface ReviewItem extends AnalyzedQuestion {
  selected: boolean;
  statusLabel: string;
  statusClass: string;
  answerPlain: string;
  mistakePlain: string;
}

const STATUS_LABEL: Record<string, string> = {
  wrong_attempt: '做错',
  not_attempted: '没做',
  unknown: '待定',
};

const STATUS_CLASS: Record<string, string> = {
  wrong_attempt: 'badge-wrong',
  not_attempted: 'badge-blank',
  unknown: 'badge-unknown',
};

/** 识别要 30–90 秒：按时间轮换提示，进度条缓慢逼近 95%，结果回来再到 100% */
const PROGRESS_STEPS: Array<{ after: number; text: string }> = [
  { after: 0, text: '上传照片' },
  { after: 4, text: '认题目' },
  { after: 15, text: '一道道拆开' },
  { after: 30, text: '写答案和讲解' },
  { after: 55, text: '快好了' },
  { after: 85, text: '题有点多，再等等' },
];

function progressAt(seconds: number): { progress: number; text: string } {
  let text = PROGRESS_STEPS[0].text;
  for (const step of PROGRESS_STEPS) if (seconds >= step.after) text = step.text;
  const progress = Math.min(95, Math.round(95 * (1 - Math.exp(-seconds / 35))));
  return { progress, text };
}

let progressTimer: number | undefined;

function stopProgress(): void {
  if (progressTimer !== undefined) clearInterval(progressTimer);
  progressTimer = undefined;
}

/** 与网页端一致：有明显做错的题时默认只勾选做错的，否则全选 */
function defaultSelected(items: AnalyzedQuestion[]): boolean[] {
  const wrong = items.map((item) => item.mistakeStatus === 'wrong_attempt');
  return wrong.some(Boolean) ? wrong : items.map(() => true);
}

Page({
  data: {
    kidMode: false,
    learnerName: '',
    imagePath: '',
    notebooks: [] as Notebook[],
    notebookIndex: 0,
    analyzing: false,
    saving: false,
    error: '',
    items: [] as ReviewItem[],
    failedCount: 0,
    imageDataUrl: '',
    provenanceId: '',
    selectedCount: 0,
    elapsed: 0,
    progress: 0,
    progressText: '',
  },

  onUnload() {
    stopProgress();
  },

  startProgress() {
    stopProgress();
    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const { progress, text } = progressAt(seconds);
      this.setData({ elapsed: seconds, progress, progressText: text });
    };
    tick();
    progressTimer = setInterval(tick, 1000) as unknown as number;
  },

  onRetake() {
    if (this.data.analyzing || this.data.saving) return;
    this.setData({ imagePath: '', items: [], error: '', imageDataUrl: '', provenanceId: '', selectedCount: 0, failedCount: 0 });
  },

  async onLoad() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      this.setData({ kidMode: ctx.kidMode, learnerName: ctx.learnerName });
      if (ctx.kidMode) return;
      const notebooks = await request<Notebook[]>('/api/notebooks');
      this.setData({ notebooks });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onChoose(e: WechatMiniprogram.BaseEvent) {
    const source = e.currentTarget.dataset.source === 'camera' ? 'camera' : 'album';
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [source],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
          this.setData({ error: '图片太大（超过 20MB），换一张吧' });
          return;
        }
        this.setData({ imagePath: file.tempFilePath, items: [], error: '', imageDataUrl: '' });
      },
    });
  },

  onPreview() {
    wx.previewImage({ urls: [this.data.imagePath] });
  },

  onNotebookChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ notebookIndex: Number(e.detail.value) });
  },

  async onAnalyze() {
    if (!this.data.imagePath) return;
    this.setData({ analyzing: true, error: '', items: [] });
    this.startProgress();
    try {
      const notebook = this.data.notebooks[this.data.notebookIndex];
      const result = await uploadImage<AnalyzeResponse>('/api/mp/analyze', this.data.imagePath, {
        language: 'zh',
        ...(notebook ? { subjectId: notebook.id } : {}),
      });
      const list = result.items && result.items.length ? result.items : [result];
      const selected = defaultSelected(list);
      this.setData({
        items: list.map((item, index) => ({
          ...item,
          selected: selected[index],
          statusLabel: STATUS_LABEL[item.mistakeStatus || 'unknown'] || '待定',
          statusClass: STATUS_CLASS[item.mistakeStatus || 'unknown'] || 'badge-unknown',
          answerPlain: toPlainText(item.answerText),
          mistakePlain: toPlainText(item.mistakeAnalysis),
        })),
        selectedCount: selected.filter(Boolean).length,
        failedCount: result.failedCount || 0,
        imageDataUrl: result.imageDataUrl || '',
        provenanceId: result.provenanceId || '',
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      stopProgress();
      this.setData({ analyzing: false });
    }
  },

  onToggleItem(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item) return;
    const selected = !item.selected;
    this.setData({
      [`items[${index}].selected`]: selected,
      selectedCount: this.data.selectedCount + (selected ? 1 : -1),
    });
  },

  onEditQuestion(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`items[${index}].questionText`]: e.detail.value });
  },

  async onSave() {
    const chosen = this.data.items.filter((item) => item.selected);
    if (chosen.length === 0) {
      wx.showToast({ title: '先勾选要保存的题', icon: 'none' });
      return;
    }
    const notebook = this.data.notebooks[this.data.notebookIndex];
    const learnerId = currentLearnerId();
    this.setData({ saving: true, error: '' });
    let saved = 0;
    let duplicates = 0;
    try {
      for (const item of chosen) {
        const res = await request<{ duplicate?: boolean }>('/api/error-items', {
          method: 'POST',
          data: {
            questionText: item.questionText,
            answerText: item.answerText,
            analysis: item.analysis,
            wrongAnswerText: item.wrongAnswerText || null,
            mistakeAnalysis: item.mistakeAnalysis || null,
            mistakeStatus: item.mistakeStatus || 'unknown',
            knowledgePoints: item.knowledgePoints ?? [],
            originalImageUrl: this.data.imageDataUrl,
            // 与网页端 saveParsedQuestion 一致：没选错题本时按识别出的学科匹配或新建
            ...(notebook ? { subjectId: notebook.id } : { subjectName: item.subject }),
            ...(learnerId ? { learnerId } : {}),
            recognizedGradeSemester: item.gradeSemester ?? null,
            difficultyStars: item.difficultyStars ?? null,
            hasFigure: item.hasFigure ?? false,
            figureSvg: item.figureSvg ?? null,
            provenanceId: this.data.provenanceId || null,
          },
        });
        if (res && res.duplicate) duplicates += 1;
        else saved += 1;
      }
      wx.showToast({ title: duplicates ? `已保存 ${saved} 题，${duplicates} 题已存在` : `已保存 ${saved} 题`, icon: duplicates ? 'none' : 'success' });
      this.setData({ items: [], imagePath: '', imageDataUrl: '', selectedCount: 0 });
      setTimeout(() => wx.switchTab({ url: '/pages/notebook/notebook' }), 800);
    } catch (error) {
      this.setData({ error: `已保存 ${saved} 题，其余失败：${toChineseMessage(error)}` });
    } finally {
      this.setData({ saving: false });
    }
  },
});
