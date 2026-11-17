export const OPEN_SETTINGS_EVENT = "wn:open-settings";

/** 通知全局导航或设置对话框打开设置面板，避免其他模块静态引入重型设置弹窗代码 */
export function requestOpenSettings() {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
    }
}
