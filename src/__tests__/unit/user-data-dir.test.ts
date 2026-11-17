import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    DISPLAY_NAME,
    USER_DATA_FOLDER,
    resolveWrongNotebookUserData,
} = require('../../../packaging/desktop/user-data-dir.js') as {
    DISPLAY_NAME: string;
    USER_DATA_FOLDER: string;
    resolveWrongNotebookUserData: (appData: string, current?: string) => string;
};

describe('resolveWrongNotebookUserData', () => {
    it('显示名是学迹，但数据目录名固定为 WrongNotebook', () => {
        expect(DISPLAY_NAME).toBe('学迹');
        expect(USER_DATA_FOLDER).toBe('WrongNotebook');
        expect(USER_DATA_FOLDER).not.toBe(DISPLAY_NAME);
    });

    it('即使当前 userData 被改成显示名，也钉回 WrongNotebook', () => {
        const appData = path.join('/Users/wayne/Library', 'Application Support');
        const drifted = path.join(appData, DISPLAY_NAME);
        const pinned = resolveWrongNotebookUserData(appData, drifted);
        expect(path.basename(pinned)).toBe('WrongNotebook');
        expect(pinned).toBe(path.join(appData, 'WrongNotebook'));
    });

    it('已经在 WrongNotebook 下时不改路径，避免折腾已有数据', () => {
        const appData = path.join('C:', 'Users', 'wayne', 'AppData', 'Roaming');
        const current = path.join(appData, 'WrongNotebook');
        expect(resolveWrongNotebookUserData(appData, current)).toBe(current);
    });
});
