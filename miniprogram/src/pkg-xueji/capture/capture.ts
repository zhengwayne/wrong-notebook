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
import {
  groupId,
  groupKeys,
  groupLabel,
  type Linkable,
  MAX_GROUP_SIZE,
  mergedSize,
  type PageContinuity,
  relinkAfterReorder,
  removePhotoAt,
  suggestMerge,
} from '../../utils/photo-groups';
import { setGradeDraft, subjectKeyFromNotebookName } from '../../utils/paper';
import { readPendingPaper, takeGradeFinished } from '../../utils/paper-store';
import { toPlainText } from '../../utils/text';
import type { AnalyzeResponse, AnalyzedQuestion, Notebook } from '../../utils/types';
import { PAGES, switchTo } from '../../utils/nav';

/** 一次最多选几张：与微信相册多选上限一致 */
const MAX_PHOTOS = 9;
/** 同时识别的组数：与网页端批量导入一致不压垮 AI；小程序再保守一点 */
const CONCURRENCY = 2;
/** 单张超过这个大小先压缩再上传（服务端单张上限 20MB，压缩后通常 0.3–1MB） */
const COMPRESS_OVER_BYTES = 1.5 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 跨页题几张一起发（JSON base64，约大 1/3）：每张压到更小，整组控制在几 MB */
const GROUP_COMPRESS_OVER_BYTES = 400 * 1024;
const GROUP_MAX_BASE64_CHARS = 15 * 1024 * 1024;
/** 识别超时：单张 150 秒；跨页题图多、输出长，放宽到 180 秒，之后转为按编号轮询 */
const SINGLE_TIMEOUT_MS = 150000;
const GROUP_TIMEOUT_MS = 180000;
/** 上传超时或网关断开后轮询结果：每 4 秒一次，最多等 6 分钟 */
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_MS = 6 * 60 * 1000;

type PhotoStatus = 'ready' | 'queued' | 'working' | 'done' | 'failed';

interface Photo extends Linkable {
  path: string;
  size: number;
  // 以下由 syncPhotos 按所在的组计算
  group: string;
  /** solo 单张；first / mid / last 为跨页组里的位置 */
  groupPos: 'solo' | 'first' | 'mid' | 'last';
  status: PhotoStatus;
  /** 识别出的题数（成功后，显示在组的最后一张） */
  count: number;
  error: string;
  failedCount: number;
  /** 建议和前一张合成一题（AI 判断跨页） */
  suggest: boolean;
}

/**
 * 每组的识别状态与结果。规范化后的原图（data URL，可能有 1MB 以上）不放进 data，
 * 避免 setData 超过 1MB 的传输上限。按组标识缓存：拆开或合上后，同样几张照片的结果直接复用。
 */
interface GroupState {
  status: PhotoStatus;
  count: number;
  error: string;
  failedCount: number;
  imageDataUrl: string;
  provenanceId: string;
  continuity?: PageContinuity;
}
const groupCache = new Map<string, GroupState>();

interface ReviewItem extends AnalyzedQuestion {
  id: number;
  /** 来自哪一组照片 */
  group: string;
  /** 照片编号：单张「3」，跨页「3-4」 */
  photoLabel: string;
  selected: boolean;
  editing: boolean;
  statusLabel: string;
  statusClass: string;
  questionPlain: string;
  answerPlain: string;
  mistakePlain: string;
}
/** 所有识别结果（含当前没在用的组），data.items 只显示当前分组对应的那些 */
let allItems: ReviewItem[] = [];
let itemSeed = 0;

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

function compressImage(path: string, size: number, overBytes: number, quality: number, width: number): Promise<string> {
  if (size <= overBytes) return Promise.resolve(path);
  return new Promise((resolve) => {
    wx.compressImage({
      src: path,
      quality,
      compressedWidth: width,
      success: (res) => resolve(res.tempFilePath),
      // 压缩失败（旧版本库不支持 compressedWidth 等）就传原图，服务端会再限边
      fail: () => resolve(path),
    });
  });
}

function readBase64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (res) => resolve(res.data as string),
      fail: reject,
    });
  });
}

function emptyGroup(): GroupState {
  return { status: 'ready', count: 0, error: '', failedCount: 0, imageDataUrl: '', provenanceId: '' };
}

/** 组里有这张照片 */
function groupHas(id: string, key: string): boolean {
  return id.split('+').indexOf(key) >= 0;
}

/** 错题本选择的第一项：不指定，按识别出的学科归类 */
const AUTO_NOTEBOOK: Notebook = { id: '', name: '自动按学科归类' };

let keySeed = 0;
let progressTimer: number | undefined;
/** 页面卸载后停止派发与轮询 */
let alive = false;

function stopTimer(): void {
  if (progressTimer !== undefined) clearInterval(progressTimer);
  progressTimer = undefined;
}

function resetResults(): void {
  groupCache.clear();
  allItems = [];
}

Page({
  data: {
    kidMode: false,
    learnerName: '',
    learnerId: '',
    /** 当前是家长给孩子录题：可以整页批改（与网页端「家长批改试卷」同一套） */
    canGrade: false,
    gradeMode: false,
    pendingPaperId: '',
    photos: [] as Photo[],
    maxPhotos: MAX_PHOTOS,
    notebooks: [AUTO_NOTEBOOK] as Notebook[],
    notebookIndex: 0,
    analyzing: false,
    saving: false,
    error: '',
    items: [] as ReviewItem[],
    selectedCount: 0,
    doneCount: 0,
    failedPhotos: 0,
    suggestCount: 0,
    elapsed: 0,
    progress: 0,
    progressText: '',
  },

  onLoad() {
    alive = true;
    resetResults();
    void this.init();
  },

  onShow() {
    // 批改页点了「再拍一份」或已确认：清空照片重新开始
    if (takeGradeFinished()) {
      resetResults();
      this.setData({ error: '' });
      this.syncPhotos([]);
    }
    if (this.data.canGrade) this.setData({ pendingPaperId: readPendingPaper(this.data.learnerId)?.id || '' });
  },

  onUnload() {
    alive = false;
    resetResults();
    stopTimer();
  },

  async init() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      this.setData({ kidMode: ctx.kidMode, learnerName: ctx.learnerName });
      if (ctx.kidMode) return;
      const canGrade = ctx.session.user.personas.includes('parent') && ctx.children.some((child) => child.id === ctx.learnerId);
      this.setData({
        canGrade,
        gradeMode: canGrade,
        learnerId: ctx.learnerId || '',
        pendingPaperId: canGrade ? readPendingPaper(ctx.learnerId)?.id || '' : '',
      });
      const notebooks = await request<Notebook[]>('/api/notebooks');
      // 与网页端一致：默认不指定错题本，由 AI 判断学科后自动放进对应错题本（没有就新建，各学科都行）
      this.setData({ notebooks: [AUTO_NOTEBOOK, ...notebooks], notebookIndex: 0 });
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
        const added = res.tempFiles
          .filter((file) => file.size <= MAX_FILE_BYTES)
          .slice(0, left)
          .map((file) => ({ key: `p${(keySeed += 1)}`, path: file.tempFilePath, size: file.size, linkPrev: false }) as Photo);
        this.setData({ error: tooBig ? `${tooBig} 张超过 20MB，没加进来` : '' });
        this.syncPhotos([...this.data.photos, ...added]);
      },
    });
  },

  onPreview(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const urls = this.data.photos.map((photo) => photo.path);
    wx.previewImage({ urls, current: urls[index] });
  },

  /** 删掉一张：含这张的组的结果一起去掉 */
  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const photo = this.data.photos[index];
    if (!photo || photo.status === 'working' || photo.status === 'queued' || this.data.saving) return;
    for (const id of Array.from(groupCache.keys())) if (groupHas(id, photo.key)) groupCache.delete(id);
    allItems = allItems.filter((item) => !groupHas(item.group, photo.key));
    this.syncPhotos(removePhotoAt(this.data.photos, index));
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
    const before = this.data.photos;
    const photos = before.slice();
    const [moved] = photos.splice(from, 1);
    photos.splice(to, 0, moved);
    this.syncPhotos(relinkAfterReorder(before, photos));
  },

  /**
   * 点两张照片之间的「连起来」：
   * - 已连上 → 拆开（之前分开识别过的结果直接恢复）；
   * - AI 建议合并（橙色）→ 连上并立即作为一题重新识别；
   * - 普通连接 → 已识别过的先确认，再连上重新识别；还没识别的只连上，等点「AI 识别」。
   */
  onLinkTap(e: WechatMiniprogram.BaseEvent) {
    if (this.data.analyzing || this.data.saving) return;
    const index = Number(e.currentTarget.dataset.index);
    const photos = this.data.photos;
    const photo = photos[index];
    if (!photo || index === 0) return;
    if (photo.linkPrev) {
      this.setLink(index, false);
      return;
    }
    if (mergedSize(photos, index) > MAX_GROUP_SIZE) {
      wx.showToast({ title: `一题最多 ${MAX_GROUP_SIZE} 张`, icon: 'none' });
      return;
    }
    const recognized = [photos[index - 1].group, photo.group].some((id) => {
      const state = groupCache.get(id);
      return !!state && state.status === 'done';
    });
    const apply = () => {
      this.setLink(index, true);
      const merged = this.data.photos[index].group;
      const cached = groupCache.get(merged);
      if (recognized && !(cached && cached.status === 'done')) void this.runQueue([merged]);
    };
    if (photo.suggest || !recognized) {
      apply();
      return;
    }
    wx.showModal({
      content: '连成一题，重新识别这几张？',
      confirmText: '连起来',
      confirmColor: '#6B5CA5',
      success: (res) => {
        if (res.confirm) apply();
      },
    });
  },

  setLink(index: number, linked: boolean) {
    const photos = this.data.photos.slice();
    photos[index] = { ...photos[index], linkPrev: linked };
    this.syncPhotos(photos);
  },

  onClearAll() {
    if (this.data.analyzing || this.data.saving) return;
    resetResults();
    this.setData({ error: '' });
    this.syncPhotos([]);
  },

  // ---------- 整页批改 ----------

  onMode(e: WechatMiniprogram.BaseEvent) {
    if (this.data.analyzing || this.data.saving || this.data.items.length) return;
    this.setData({ gradeMode: e.currentTarget.dataset.mode === 'grade' });
  },

  /** 所有照片作为一份试卷的各页交给批改页（跨页的题由 AI 按页序处理，不用手动连） */
  onGrade() {
    if (!this.data.canGrade || !this.data.photos.length || this.data.analyzing || this.data.saving) return;
    setGradeDraft({
      learnerId: this.data.learnerId,
      learnerName: this.data.learnerName,
      subjectKey: subjectKeyFromNotebookName(this.chosenNotebook()?.name),
      photos: this.data.photos.map((photo) => ({ path: photo.path, size: photo.size })),
    });
    wx.navigateTo({ url: PAGES.xjGrade });
  },

  onResumePaper() {
    if (this.data.pendingPaperId) wx.navigateTo({ url: `${PAGES.xjGrade}?id=${encodeURIComponent(this.data.pendingPaperId)}` });
  },

  onNotebookChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ notebookIndex: Number(e.detail.value) });
  },

  /** 选中的错题本；「自动按学科归类」返回 undefined */
  chosenNotebook(): Notebook | undefined {
    const notebook = this.data.notebooks[this.data.notebookIndex];
    return notebook && notebook.id ? notebook : undefined;
  },

  /**
   * 按连接关系重新分组，算出每张照片的显示状态、合并建议，以及当前分组对应的题目列表。
   * 所有改动照片和识别结果的地方最后都调用它。
   */
  syncPhotos(next?: Photo[]) {
    const base = next || this.data.photos;
    const groups = groupKeys(base);
    const groupOfKey = new Map<string, string[]>();
    for (const keys of groups) for (const key of keys) groupOfKey.set(key, keys);
    const indexOf = new Map(base.map((photo, index) => [photo.key, index]));

    const photos: Photo[] = base.map((photo, index) => {
      const keys = groupOfKey.get(photo.key) as string[];
      const id = groupId(keys);
      const state = groupCache.get(id) || emptyGroup();
      const position = keys.indexOf(photo.key);
      const groupPos: Photo['groupPos'] = keys.length === 1 ? 'solo' : position === 0 ? 'first' : position === keys.length - 1 ? 'last' : 'mid';
      let suggest = false;
      if (index > 0 && position === 0) {
        const prevKeys = groupOfKey.get(base[index - 1].key) as string[];
        const prev = groupCache.get(groupId(prevKeys));
        suggest = !!prev && prev.status === 'done' && state.status === 'done'
          && prevKeys.length + keys.length <= MAX_GROUP_SIZE
          // 合过又拆开的不再提示
          && !groupCache.has(groupId([...prevKeys, ...keys]))
          && suggestMerge(prev.continuity, state.continuity);
      }
      return {
        key: photo.key,
        path: photo.path,
        size: photo.size,
        linkPrev: index > 0 && photo.linkPrev,
        group: id,
        groupPos,
        status: state.status,
        count: state.count,
        error: state.error,
        failedCount: state.failedCount,
        suggest,
      };
    });

    const order = new Map(groups.map((keys, index) => [groupId(keys), index]));
    const labels = new Map(groups.map((keys) => [groupId(keys), groupLabel(keys.map((key) => indexOf.get(key) as number))]));
    const items = allItems
      .filter((item) => order.has(item.group))
      .sort((a, b) => (order.get(a.group)! - order.get(b.group)!) || a.id - b.id)
      .map((item) => ({ ...item, photoLabel: labels.get(item.group) || '' }));

    this.setData({
      photos,
      items,
      selectedCount: items.filter((item) => item.selected).length,
      doneCount: photos.filter((photo) => photo.status === 'done').length,
      failedPhotos: photos.filter((photo) => photo.status === 'failed').length,
      suggestCount: photos.filter((photo) => photo.suggest).length,
    });
  },

  // ---------- 识别 ----------

  /** 识别所有还没识别成功的组（第一次识别，或者只重试失败的） */
  async onAnalyze() {
    if (this.data.analyzing || this.data.saving) return;
    const todo: string[] = [];
    for (const photo of this.data.photos) {
      if ((photo.status === 'ready' || photo.status === 'failed') && todo.indexOf(photo.group) < 0) todo.push(photo.group);
    }
    if (!todo.length) return;
    await this.runQueue(todo);
  },

  /** 点某张失败的照片单独重试（整组） */
  async onRetryPhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const photo = this.data.photos[index];
    if (!photo || photo.status !== 'failed') return;
    if (this.data.analyzing) {
      wx.showToast({ title: '等这一轮认完再重试', icon: 'none' });
      return;
    }
    await this.runQueue([photo.group]);
  },

  async runQueue(ids: string[]) {
    const pending = ids.slice();
    for (const id of ids) groupCache.set(id, { ...(groupCache.get(id) || emptyGroup()), status: 'queued', error: '' });
    this.setData({ analyzing: true, error: '' });
    this.syncPhotos();
    this.startTimer();
    const worker = async () => {
      while (alive && pending.length) {
        const id = pending.shift() as string;
        await this.analyzeGroup(id);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    } finally {
      stopTimer();
      if (alive) {
        this.setData({ analyzing: false });
        this.syncPhotos();
        const failed = this.data.failedPhotos;
        if (failed) wx.showToast({ title: `${failed} 张没认出来，可重试`, icon: 'none' });
      }
    }
  },

  updateGroup(id: string, patch: Partial<GroupState>) {
    groupCache.set(id, { ...(groupCache.get(id) || emptyGroup()), ...patch });
    this.syncPhotos();
  },

  /** 识别一组：单张用 wx.uploadFile；跨页的几张压缩后一起用 JSON 发，服务端只调一次 AI、只计一次 */
  async analyzeGroup(id: string) {
    const keys = id.split('+');
    const members = keys.map((key) => this.data.photos.find((photo) => photo.key === key));
    if (members.some((photo) => !photo)) return;
    const photos = members as Photo[];
    this.updateGroup(id, { status: 'working', error: '' });
    const requestId = newRequestId();
    try {
      const notebook = this.chosenNotebook();
      let result: AnalyzeResponse;
      try {
        if (photos.length === 1) {
          const filePath = await compressImage(photos[0].path, photos[0].size, COMPRESS_OVER_BYTES, 80, 2560);
          result = await uploadImage<AnalyzeResponse>('/api/mp/analyze', filePath, {
            language: 'zh',
            ...(notebook ? { subjectId: notebook.id } : {}),
          }, { requestId, timeout: SINGLE_TIMEOUT_MS });
        } else {
          const images: string[] = [];
          for (const photo of photos) {
            images.push(await readBase64(await compressImage(photo.path, photo.size, GROUP_COMPRESS_OVER_BYTES, 75, 1600)));
          }
          if (images.reduce((sum, image) => sum + image.length, 0) > GROUP_MAX_BASE64_CHARS) throw new ApiError(413, '');
          result = await request<AnalyzeResponse>('/api/mp/analyze', {
            method: 'POST',
            data: { images, language: 'zh', ...(notebook ? { subjectId: notebook.id } : {}) },
            requestId,
            timeout: GROUP_TIMEOUT_MS,
          });
        }
      } catch (error) {
        // 网络超时、网关断开时服务端可能还在识别：按请求编号取回结果
        if (!isLostResponse(error)) throw error;
        result = await this.waitForResult(requestId, error);
      }
      if (!alive || !keys.every((key) => this.data.photos.some((photo) => photo.key === key))) return;
      const list = result.items && result.items.length ? result.items : [result];
      const selected = defaultSelected(list);
      allItems = allItems.filter((item) => item.group !== id).concat(list.map((item, index) => ({
        ...item,
        id: (itemSeed += 1),
        group: id,
        photoLabel: '',
        selected: selected[index],
        editing: false,
        statusLabel: STATUS_LABEL[item.mistakeStatus || 'unknown'] || '待定',
        statusClass: STATUS_CLASS[item.mistakeStatus || 'unknown'] || 'badge-unknown',
        questionPlain: toPlainText(item.questionText),
        answerPlain: toPlainText(item.answerText),
        mistakePlain: toPlainText(item.mistakeAnalysis),
      })));
      this.updateGroup(id, {
        status: 'done',
        count: list.length,
        failedCount: result.failedCount || 0,
        imageDataUrl: result.imageDataUrl || '',
        provenanceId: result.provenanceId || '',
        continuity: result.continuity,
      });
    } catch (error) {
      if (!alive) return;
      this.updateGroup(id, { status: 'failed', error: toChineseMessage(error) });
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

  /** 改动同时写回 allItems，重新分组后不丢 */
  patchItem(index: number, patch: Partial<ReviewItem>) {
    const item = this.data.items[index];
    if (!item) return;
    const source = allItems.find((entry) => entry.id === item.id);
    if (source) Object.assign(source, patch);
    const updates: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) updates[`items[${index}].${field}`] = value;
    this.setData(updates);
  },

  onToggleItem(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item) return;
    const selected = !item.selected;
    this.patchItem(index, { selected });
    this.setData({ selectedCount: this.data.selectedCount + (selected ? 1 : -1) });
  },

  onEditToggle(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item) return;
    this.patchItem(index, { editing: !item.editing, questionPlain: toPlainText(item.questionText) });
  },

  onEditQuestion(e: WechatMiniprogram.Input) {
    this.patchItem(Number(e.currentTarget.dataset.index), { questionText: e.detail.value });
  },

  async onSave() {
    if (this.data.analyzing || this.data.saving) return;
    const chosen = this.data.items.filter((item) => item.selected);
    if (chosen.length === 0) {
      wx.showToast({ title: '先勾选要保存的题', icon: 'none' });
      return;
    }
    const notebook = this.chosenNotebook();
    const learnerId = currentLearnerId();
    this.setData({ saving: true, error: '' });
    let saved = 0;
    let duplicates = 0;
    const savedIds = new Set<number>();
    try {
      for (const item of chosen) {
        const group = groupCache.get(item.group);
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
            // 每道题存它所在那组照片：跨页题是服务端拼好的一张，包含全部几页
            originalImageUrl: group ? group.imageDataUrl : '',
            // 与网页端 saveParsedQuestion 一致：没选错题本时按识别出的学科匹配或新建（各学科都一样）
            ...(notebook ? { subjectId: notebook.id } : { subjectName: item.subject }),
            ...(learnerId ? { learnerId } : {}),
            recognizedGradeSemester: item.gradeSemester ?? null,
            difficultyStars: item.difficultyStars ?? null,
            hasFigure: item.hasFigure ?? false,
            figureSvg: item.figureSvg ?? null,
            provenanceId: (group && group.provenanceId) || null,
          },
        });
        savedIds.add(item.id);
        if (res && res.duplicate) duplicates += 1;
        else saved += 1;
      }
      wx.showToast({ title: duplicates ? `已保存 ${saved} 题，${duplicates} 题已存在` : `已保存 ${saved} 题`, icon: duplicates ? 'none' : 'success' });
      resetResults();
      this.syncPhotos([]);
      setTimeout(() => switchTo(PAGES.xjNotebook), 800);
    } catch (error) {
      // 已保存的题从列表去掉，重试时不会重复保存
      allItems = allItems.filter((item) => !savedIds.has(item.id));
      this.syncPhotos();
      this.setData({ error: `已保存 ${saved + duplicates} 题，其余没保存：${toChineseMessage(error)}` });
    } finally {
      this.setData({ saving: false });
    }
  },
});
