/**
 * 专注模式锁条 + 家长 PIN 键盘。
 * 出现在每个 tab 页顶部：点锁图标弹出 4 位数字键盘，输满自动经 POST /api/parent/kid-mode/unlock 校验（与网页端锁条同一接口）。
 * 解锁成功后清掉本地专注锁并触发 unlocked 事件；网络失败保留已输 PIN，可点重试。
 */
import { clearKidLock, request } from '../../utils/request';
import { classifyUnlockFailure, PIN_LENGTH, pressPinKey } from '../../utils/kid-lock';
import type { UnlockFailureKind } from '../../utils/kid-lock';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

Component({
  options: { addGlobalClass: true },

  properties: {
    learnerName: { type: String, value: '' },
  },

  data: {
    open: false,
    pin: '',
    dots: [false, false, false, false],
    keys: KEYS,
    busy: false,
    failKind: '' as UnlockFailureKind | '',
    message: '',
  },

  methods: {
    onOpen() {
      this.setData({ open: true, pin: '', dots: [false, false, false, false], failKind: '', message: '' });
    },

    onClose() {
      if (this.data.busy) return;
      this.setData({ open: false, pin: '' });
    },

    noop() {},

    onKey(e: WechatMiniprogram.BaseEvent) {
      if (this.data.busy) return;
      const key = String(e.currentTarget.dataset.key || '');
      if (!key) return;
      const pin = pressPinKey(this.data.pin, key);
      // 重新输入时清掉上一次的错误提示（网络失败时保留重试按钮直到 PIN 被改动）
      this.setPin(pin, pin === this.data.pin ? this.data.failKind : '');
      if (pin.length === PIN_LENGTH && key !== 'del') void this.submit();
    },

    onRetry() {
      void this.submit();
    },

    setPin(pin: string, failKind: UnlockFailureKind | '' = '') {
      this.setData({
        pin,
        dots: Array.from({ length: PIN_LENGTH }, (_, i) => i < pin.length),
        failKind,
        message: failKind ? this.data.message : '',
      });
    },

    async submit() {
      const pin = this.data.pin;
      if (pin.length !== PIN_LENGTH || this.data.busy) return;
      this.setData({ busy: true, failKind: '', message: '' });
      try {
        await request('/api/parent/kid-mode/unlock', { method: 'POST', data: { pin } });
        // 响应的 Set-Cookie 已清锁；这里再显式清一次，防止个别机型拿不到 Set-Cookie 留下残留
        clearKidLock();
        this.setData({ busy: false, open: false, pin: '' });
        wx.showToast({ title: '已解锁', icon: 'success' });
        this.triggerEvent('unlocked');
      } catch (error) {
        const failure = classifyUnlockFailure(error);
        this.setData({ busy: false, failKind: failure.kind, message: failure.message });
        // 输错、锁定：清空重输；网络问题：保留 PIN 方便重试
        if (failure.kind !== 'network') {
          this.setData({ pin: '', dots: [false, false, false, false] });
        }
      }
    },
  },
});
