import { currentLearnerId, loadContext } from '../../utils/context';
import {
  ApiError,
  fetchStoredResponse,
  isLostResponse,
  newRequestId,
  request,
  type StoredResponse,
  toChineseMessage,
  uploadImage,
} from '../../utils/request';
import { toPlainText } from '../../utils/text';
import type { AnalyzeResponse, AnalyzedQuestion, Notebook } from '../../utils/types';

/** 一次最多选几张：与微信相册多选上限一致 */
const MAX_PHOTOS = 9;
/** 同时识别的张数：与网页端批量导入一致不压垮 AI；小程序再保守一点 */
const CONCURRENCY = 2;
/** 单张超过这个大小先压缩再上传（服务端单张上限 20MB，压缩后通常 0.3–1MB） */
const COMPRESS_OVER_BYTES = 1.5 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 上传超时或网关断开后轮询结果：每 4 秒一次，最多等 6 分钟 */
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_MS = 6 * 60 * 1000;

type PhotoStatus = 'ready' | 'queued' | 'working' | 'done' | 'failed';

interface Photo {
  key: string;
  path: string;
  size: number;
  status: PhotoStatus;
  /** 识别出的题数（成功后） */
  count: number;
  error: string;
  failedCount: number;
}

/**
 * 每张照片规范化后的原图（data URL，可能有 1MB 以上）和溯源编号：不放进 data，
 * 避免 setData 超过 1MB 的传输上限，也不用渲染。
 */
const photoResults = new Map<string, { imageDataUrl: string; provenanceId: string }>();

interface ReviewItem extends AnalyzedQuestion {
  /** 来自第几张照片（Photo.key） */
  photoKey: string;
  photoNo: number;
  selected: boolean;
  editing: boolean;
  statusLabel: string;
  statusClass: string;
  questionPlain: string;
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

/** 识别要 30–90 秒：按时间轮换提示 */
const PROGRESS_STEPS: Array<{ after: number; text: string }> = [
  { after: 0, text: '上传照片' },
  { after: 4, text: '认题目' },
  { after: 15, text: '一道道拆开' },
  { after: 30, text: '写答案和讲解' },
  { after: 55, text: '快好了' },
  { after: 85, text: '题有点多，再等等' },
];

function progressText(seconds: number): string {
  let text = PROGRESS_STEPS[0].text;
  for (const step of PROGRESS_STEPS) if (seconds >= step.after) text = step.text;
  return text;
}

/** 与网页端一致：有明显做错的题时默认只勾选做错的，否则全选 */
function defaultSelected(items: AnalyzedQuestion[]): boolean[] {
  const wrong = items.map((item) => item.mistakeStatus === 'wrong_attempt');
  return wrong.some(Boolean) ? wrong : items.map(() => true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compressIfLarge(path: string, size: number): Promise<string> {
  if (size <= COMPRESS_OVER_BYTES) return Promise.resolve(path);
  return new Promise((resolve) => {
    wx.compressImage({
      src: path,
      quality: 80,
      compressedWidth: 2560,
      success: (res) => resolve(res.tempFilePath),
      // 压缩失败（旧版本库不支持 compressedWidth 等）就传原图，服务端会再限边
      fail: () => resolve(path),
    });
  });
}

let keySeed = 0;
let progressTimer: number | undefined;
/** 页面卸载后停止派发与轮询 */
let alive = false;

function stopTimer(): void {
  if (progressTimer !== undefined) clearInterval(progressTimer);
  progressTimer = undefined;
}

Page({
  data: {
    kidMode: false,
    learnerName: '',
    photos: [] as Photo[],
    maxPhotos: MAX_PHOTOS,
    notebooks: [] as Notebook[],
    notebookIndex: 0,
    analyzing: false,
    saving: false,
    error: '',
    items: [] as ReviewItem[],
    selectedCount: 0,
    doneCount: 0,
    failedPhotos: 0,
    elapsed: 0,
    progress: 0,
    progressText: '',
  },

  onLoad() {
    alive = true;
    photoResults.clear();
    void this.init();
  },

  onUnload() {
    alive = false;
    photoResults.clear();
    stopTimer();
  },

  async init() {
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

  // ---------- 选照片 ----------

  onChoose(e: WechatMiniprogram.BaseEvent) {
    if (this.data.analyzing || this.data.saving) return;
    const left = MAX_PHOTOS - this.data.photos.length;
    if (left <= 0) {
      wx.showToast({ title: `最多 ${MAX_PHOTOS} 张`, icon: 'none' });
      return;
    }
    const source = e.currentTarget.dataset.source as string | undefined;
    const sourceType: Array<'camera' | 'album'> = source === 'camera' ? ['camera'] : source === 'album' ? ['album'] : ['camera', 'album'];
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed'],
      success: (res) => {
        const tooBig = res.tempFiles.filter((file) => file.size > MAX_FILE_BYTES).length;
        const added: Photo[] = res.tempFiles
          .filter((file) => file.size <= MAX_FILE_BYTES)
          .slice(0, left)
          .map((file) => ({
            key: `p${(keySeed += 1)}`,
            path: file.tempFilePath,
            size: file.size,
            status: 'ready' as PhotoStatus,
            count: 0,
            error: '',
            failedCount: 0,
          }));
        this.setData({
          photos: [...this.data.photos, ...added],
          error: tooBig ? `${tooBig} 张超过 20MB，没加进来` : '',
        });
      },
    });
  },

  onPreview(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const urls = this.data.photos.map((photo) => photo.path);
    wx.previewImage({ urls, current: urls[index] });
  },

  /** 删掉一张：已识别的题一起去掉 */
  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const photo = this.data.photos[index];
    if (!photo || photo.status === 'working' || photo.status === 'queued' || this.data.saving) return;
    const photos = this.data.photos.filter((_, i) => i !== index);
    photoResults.delete(photo.key);
    this.setData({ photos });
    this.rebuildItems(this.data.items.filter((item) => item.photoKey !== photo.key));
  },

  /** 长按调整顺序（识别前） */
  onPhotoMenu(e: WechatMiniprogram.BaseEvent) {
    if (this.data.analyzing || this.data.saving) return;
    const index = Number(e.currentTarget.dataset.index);
    const count = this.data.photos.length;
    const actions: Array<{ label: string; run: () => void }> = [];
    if (index > 0) actions.push({ label: '往前挪', run: () => this.movePhoto(index, index - 1) });
    if (index < count - 1) actions.push({ label: '往后挪', run: () => this.movePhoto(index, index + 1) });
    actions.push({ label: '删除', run: () => this.onRemovePhoto({ currentTarget: { dataset: { index } } } as unknown as WechatMiniprogram.BaseEvent) });
    wx.showActionSheet({
      itemList: actions.map((action) => action.label),
      success: (res) => actions[res.tapIndex]?.run(),
    });
  },

  movePhoto(from: number, to: number) {
    const photos = this.data.photos.slice();
    const [moved] = photos.splice(from, 1);
    photos.splice(to, 0, moved);
    this.setData({ photos });
    this.rebuildItems(this.data.items);
  },

  onClearAll() {
    if (this.data.analyzing || this.data.saving) return;
    photoResults.clear();
    this.setData({ photos: [], items: [], error: '', selectedCount: 0, doneCount: 0, failedPhotos: 0 });
  },

  onNotebookChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ notebookIndex: Number(e.detail.value) });
  },

  // ---------- 识别 ----------

  /** 识别所有还没识别成功的照片（第一次识别，或者只重试失败的） */
  async onAnalyze() {
    if (this.data.analyzing || this.data.saving) return;
    const todo = this.data.photos.filter((photo) => photo.status === 'ready' || photo.status === 'failed');
    if (!todo.length) return;
    await this.runQueue(todo.map((photo) => photo.key));
  },

  /** 点某张失败的照片单独重试 */
  async onRetryPhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const photo = this.data.photos[index];
    if (!photo || photo.status !== 'failed') return;
    if (this.data.analyzing) {
      wx.showToast({ title: '等这一轮认完再重试', icon: 'none' });
      return;
    }
    await this.runQueue([photo.key]);
  },

  async runQueue(keys: string[]) {
    const pending = keys.slice();
    for (const key of keys) this.updatePhoto(key, { status: 'queued', error: '' });
    this.setData({ analyzing: true, error: '' });
    this.startTimer();
    const worker = async () => {
      while (alive && pending.length) {
        const key = pending.shift() as string;
        await this.analyzeOne(key);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));
    } finally {
      stopTimer();
      if (alive) {
        this.setData({ analyzing: false });
        this.refreshCounts();
        const failed = this.data.failedPhotos;
        if (failed) wx.showToast({ title: `${failed} 张没认出来，可重试`, icon: 'none' });
      }
    }
  },

  async analyzeOne(key: string) {
    const photo = this.data.photos.find((item) => item.key === key);
    if (!photo) return;
    this.updatePhoto(key, { status: 'working', error: '' });
    const requestId = newRequestId();
    try {
      const notebook = this.data.notebooks[this.data.notebookIndex];
      const filePath = await compressIfLarge(photo.path, photo.size);
      let result: AnalyzeResponse;
      try {
        result = await uploadImage<AnalyzeResponse>('/api/mp/analyze', filePath, {
          language: 'zh',
          ...(notebook ? { subjectId: notebook.id } : {}),
        }, { requestId, timeout: 150000 });
      } catch (error) {
        // 网络超时、网关断开时服务端可能还在识别：按请求编号取回结果
        if (!isLostResponse(error)) throw error;
        result = await this.waitForResult(requestId, error);
      }
      if (!alive || !this.data.photos.some((item) => item.key === key)) return;
      photoResults.set(key, { imageDataUrl: result.imageDataUrl || '', provenanceId: result.provenanceId || '' });
      const list = result.items && result.items.length ? result.items : [result];
      this.updatePhoto(key, {
        status: 'done',
        count: list.length,
        failedCount: result.failedCount || 0,
      });
      this.appendItems(key, list);
    } catch (error) {
      if (!alive) return;
      this.updatePhoto(key, { status: 'failed', error: toChineseMessage(error) });
    } finally {
      if (alive) this.refreshCounts();
    }
  },

  async waitForResult(requestId: string, original: unknown): Promise<AnalyzeResponse> {
    const startedAt = Date.now();
    let missingStreak = 0;
    while (alive && Date.now() - startedAt < POLL_MAX_MS) {
      await sleep(POLL_INTERVAL_MS);
      let stored: StoredResponse<AnalyzeResponse & { message?: string }>;
      try {
        stored = await fetchStoredResponse<AnalyzeResponse & { message?: string }>(requestId);
      } catch {
        continue; // 网络还没恢复，下次再查
      }
      if (stored.state === 'running') {
        missingStreak = 0;
        continue;
      }
      if (stored.state === 'done') {
        if (stored.status >= 200 && stored.status < 300) return stored.body;
        throw new ApiError(stored.status, stored.body && typeof stored.body.message === 'string' ? stored.body.message : '');
      }
      // 没查到：请求可能还在路上（刚登记），连续几次都没有才算没到服务端
      missingStreak += 1;
      if (missingStreak >= 3) break;
    }
    throw original;
  },

  updatePhoto(key: string, patch: Partial<Photo>) {
    const index = this.data.photos.findIndex((photo) => photo.key === key);
    if (index < 0) return;
    const updates: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) updates[`photos[${index}].${field}`] = value;
    this.setData(updates);
  },

  refreshCounts() {
    const photos = this.data.photos;
    this.setData({
      doneCount: photos.filter((photo) => photo.status === 'done').length,
      failedPhotos: photos.filter((photo) => photo.status === 'failed').length,
    });
  },

  appendItems(key: string, list: AnalyzedQuestion[]) {
    const selected = defaultSelected(list);
    const added: ReviewItem[] = list.map((item, index) => ({
      ...item,
      photoKey: key,
      photoNo: 0,
      selected: selected[index],
      editing: false,
      statusLabel: STATUS_LABEL[item.mistakeStatus || 'unknown'] || '待定',
      statusClass: STATUS_CLASS[item.mistakeStatus || 'unknown'] || 'badge-unknown',
      questionPlain: toPlainText(item.questionText),
      answerPlain: toPlainText(item.answerText),
      mistakePlain: toPlainText(item.mistakeAnalysis),
    }));
    this.rebuildItems([...this.data.items.filter((item) => item.photoKey !== key), ...added]);
  },

  /** 题目按照片顺序排列，并标上第几张 */
  rebuildItems(items: ReviewItem[]) {
    const order = new Map(this.data.photos.map((photo, index) => [photo.key, index]));
    const sorted = items
      .filter((item) => order.has(item.photoKey))
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (order.get(a.item.photoKey)! - order.get(b.item.photoKey)!) || a.index - b.index)
      .map(({ item }) => ({ ...item, photoNo: order.get(item.photoKey)! + 1 }));
    this.setData({ items: sorted, selectedCount: sorted.filter((item) => item.selected).length });
  },

  startTimer() {
    stopTimer();
    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const total = this.data.photos.length || 1;
      const finished = this.data.photos.filter((photo) => photo.status === 'done' || photo.status === 'failed').length;
      const working = this.data.photos.filter((photo) => photo.status === 'working').length;
      // 已完成的张数 + 进行中的张数按时间缓慢逼近一张
      const partial = working * (1 - Math.exp(-seconds / 40)) * 0.9;
      const progress = Math.min(99, Math.round(((finished + partial) / total) * 100));
      this.setData({ elapsed: seconds, progress, progressText: progressText(seconds) });
    };
    tick();
    progressTimer = setInterval(tick, 1000) as unknown as number;
  },

  // ---------- 核对与保存 ----------

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

  onEditToggle(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item) return;
    this.setData({
      [`items[${index}].editing`]: !item.editing,
      [`items[${index}].questionPlain`]: toPlainText(item.questionText),
    });
  },

  onEditQuestion(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`items[${index}].questionText`]: e.detail.value });
  },

  async onSave() {
    if (this.data.analyzing || this.data.saving) return;
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
    const savedItems = new Set<ReviewItem>();
    try {
      for (const item of chosen) {
        const photo = photoResults.get(item.photoKey);
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
            // 每道题存它所在那张照片
            originalImageUrl: photo ? photo.imageDataUrl : '',
            // 与网页端 saveParsedQuestion 一致：没选错题本时按识别出的学科匹配或新建（各学科都一样）
            ...(notebook ? { subjectId: notebook.id } : { subjectName: item.subject }),
            ...(learnerId ? { learnerId } : {}),
            recognizedGradeSemester: item.gradeSemester ?? null,
            difficultyStars: item.difficultyStars ?? null,
            hasFigure: item.hasFigure ?? false,
            figureSvg: item.figureSvg ?? null,
            provenanceId: (photo && photo.provenanceId) || null,
          },
        });
        savedItems.add(item);
        if (res && res.duplicate) duplicates += 1;
        else saved += 1;
      }
      wx.showToast({ title: duplicates ? `已保存 ${saved} 题，${duplicates} 题已存在` : `已保存 ${saved} 题`, icon: duplicates ? 'none' : 'success' });
      photoResults.clear();
      this.setData({ items: [], photos: [], selectedCount: 0, doneCount: 0, failedPhotos: 0 });
      setTimeout(() => wx.switchTab({ url: '/pages/notebook/notebook' }), 800);
    } catch (error) {
      // 已保存的题从列表去掉，重试时不会重复保存
      this.rebuildItems(this.data.items.filter((item) => !savedItems.has(item)));
      this.setData({ error: `已保存 ${saved + duplicates} 题，其余没保存：${toChineseMessage(error)}` });
    } finally {
      this.setData({ saving: false });
    }
  },
});
