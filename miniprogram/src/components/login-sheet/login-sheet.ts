/**
 * 登录框（底部小弹层）：游客用到拍照、保存、记录等功能时才弹出。
 * 微信一键登录 + 勾选《用户隐私保护指引》（默认不勾选）+「暂不登录」；隐私指引不登录也能看。
 * 登录成功后 open() 返回 true，页面继续刚才的操作；暂不登录 / 点空白 / 下滑关闭返回 false，只影响这次操作。
 */
import { notifyLoggedIn } from '../../utils/auth';
import { loadContext } from '../../utils/context';
import { migrateGuestProgress } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { loginWithWechat } from '../../utils/session';

let settle: ((ok: boolean) => void) | null = null;

Component({
  options: { addGlobalClass: true },

  data: {
    show: false,
    reason: '',
    agreed: false,
    loading: false,
    error: '',
  },

  lifetimes: {
    detached() {
      this.finish(false);
    },
  },

  methods: {
    /** 打开登录框；结果：true 登录成功，false 暂不登录 */
    open(reason?: string): Promise<boolean> {
      this.finish(false);
      this.setData({ show: true, reason: reason || '', error: '', loading: false });
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    },

    finish(ok: boolean) {
      const done = settle;
      settle = null;
      if (done) done(ok);
    },

    onToggleAgree() {
      this.setData({ agreed: !this.data.agreed, error: '' });
    },

    onOpenPrivacy() {
      wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时打不开', icon: 'none' }) });
    },

    onCancel() {
      if (this.data.loading) return;
      this.setData({ show: false });
      this.finish(false);
    },

    /** 下滑 / 返回键关掉时 page-container 触发：没登录成功就算「暂不登录」 */
    onLeave() {
      if (this.data.show) this.setData({ show: false });
      this.finish(false);
    },

    async onLogin() {
      if (this.data.loading) return;
      if (!this.data.agreed) {
        this.setData({ error: '请先勾选同意《用户隐私保护指引》' });
        return;
      }
      this.setData({ loading: true, error: '' });
      try {
        const { user } = await loginWithWechat();
        migrateGuestProgress(user.id);
        // 先把会话与当前学习者放进全局状态，页面的 onLoggedIn 和继续的操作都能用
        await loadContext().catch(() => undefined);
        await notifyLoggedIn().catch(() => undefined);
        this.setData({ show: false, loading: false });
        this.finish(true);
      } catch (error) {
        this.setData({ error: toChineseMessage(error), loading: false });
      }
    },
  },
});
