'use strict';

/**
 * 桌面版对外显示名为「学迹 / XueJi」，但历史数据目录是 WrongNotebook。
 * 必须与 electron-builder 的 productName 保持一致，不能用显示名去改 app.setName()，
 * 否则 userData 会迁到新目录，已有数据库会「消失」。
 */
const DISPLAY_NAME = '学迹';
const USER_DATA_FOLDER = 'WrongNotebook';

/**
 * @param {string} appData 系统应用数据根目录（app.getPath('appData')）
 * @param {string} [currentUserData] 当前 app.getPath('userData')
 * @returns {string} 应使用的 userData 绝对路径
 */
function resolveWrongNotebookUserData(appData, currentUserData) {
    const path = require('node:path');
    const pinned = path.join(appData, USER_DATA_FOLDER);
    if (!currentUserData) return pinned;
    if (path.basename(currentUserData) === USER_DATA_FOLDER) return currentUserData;
    return pinned;
}

module.exports = {
    DISPLAY_NAME,
    USER_DATA_FOLDER,
    resolveWrongNotebookUserData,
};
