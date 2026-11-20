/**
 * 打印与导出「是否带答案」的本机偏好：默认不带答案，勾选后记在本机浏览器
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    EXAM_PRINT_INCLUDE_ANSWERS_KEY,
    readStoredFlag,
    useStoredFlag,
    writeStoredFlag,
} from '@/lib/print-answer-preference';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
    const [value, set] = useStoredFlag(EXAM_PRINT_INCLUDE_ANSWERS_KEY, false);
    return <button type="button" onClick={() => set(!value)}>{value ? 'on' : 'off'}</button>;
}

describe('print-answer-preference', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        localStorage.clear();
    });

    it('未保存时默认不带答案', () => {
        expect(readStoredFlag(EXAM_PRINT_INCLUDE_ANSWERS_KEY)).toBe(false);
        act(() => root.render(<Probe />));
        expect(container.textContent).toBe('off');
    });

    it('勾选后写入本机，下次打开沿用', () => {
        act(() => root.render(<Probe />));
        act(() => container.querySelector('button')!.click());
        expect(container.textContent).toBe('on');
        expect(localStorage.getItem(EXAM_PRINT_INCLUDE_ANSWERS_KEY)).toBe('1');

        act(() => root.unmount());
        root = createRoot(container);
        act(() => root.render(<Probe />));
        expect(container.textContent).toBe('on');
    });

    it('无法识别的旧值回退为默认值', () => {
        localStorage.setItem(EXAM_PRINT_INCLUDE_ANSWERS_KEY, 'yes');
        expect(readStoredFlag(EXAM_PRINT_INCLUDE_ANSWERS_KEY, false)).toBe(false);
        writeStoredFlag(EXAM_PRINT_INCLUDE_ANSWERS_KEY, false);
        expect(localStorage.getItem(EXAM_PRINT_INCLUDE_ANSWERS_KEY)).toBe('0');
    });
});
