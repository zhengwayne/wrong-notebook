import { currentLearnerId, loadContext } from '../../utils/context';
import { request, toChineseMessage, uploadImage } from '../../utils/request';
import { toPlainText } from '../../utils/text';
import type { AnalyzeResponse, AnalyzedQuestion, Notebook } from '../../utils/types';

interface ReviewItem extends AnalyzedQuestion {
  selected: boolean;
  statusLabel: string;
  answerPlain: string;
  mistakePlain: string;
}

const STATUS_LABEL: Record<string, string> = {
  wrong_attempt: '做错了',
  not_attempted: '没作答',
  unknown: '未判断',
};

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
          this.setData({ error: '图片超过 20MB，请换一张' });
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
          statusLabel: STATUS_LABEL[item.mistakeStatus || 'unknown'] || '未判断',
          answerPlain: toPlainText(item.answerText),
          mistakePlain: toPlainText(item.mistakeAnalysis),
        })),
        failedCount: result.failedCount || 0,
        imageDataUrl: result.imageDataUrl || '',
        provenanceId: result.provenanceId || '',
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ analyzing: false });
    }
  },

  onToggleItem(e: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`items[${index}].selected`]: e.detail.value.includes('on') });
  },

  onEditQuestion(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`items[${index}].questionText`]: e.detail.value });
  },

  async onSave() {
    const chosen = this.data.items.filter((item) => item.selected);
    if (chosen.length === 0) {
      wx.showToast({ title: '请至少勾选一题', icon: 'none' });
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
      wx.showToast({ title: duplicates ? `已保存 ${saved} 题，${duplicates} 题已存在` : `已保存 ${saved} 题`, icon: 'success' });
      this.setData({ items: [], imagePath: '', imageDataUrl: '' });
      setTimeout(() => wx.switchTab({ url: '/pages/notebook/notebook' }), 800);
    } catch (error) {
      this.setData({ error: `已保存 ${saved} 题，其余失败：${toChineseMessage(error)}` });
    } finally {
      this.setData({ saving: false });
    }
  },
});
