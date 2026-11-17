import { describe, expect, it, vi } from 'vitest';
import {
    CURRENT_CHILD_STORAGE_KEY,
    childIdFromSearchParams,
    currentChildStorageKey,
    isUsableChildId,
    moveItem,
    readStoredChild,
    withChildParam,
    writeStoredChild,
} from '@/lib/current-child';
import { isHeicFile } from '@/lib/heic';
import { isPaperPageImage } from '@/lib/parent-papers';

describe('current child helpers', () => {
    it('reads learnerId first and ignores self studentKey', () => {
        expect(childIdFromSearchParams(new URLSearchParams('learnerId=child-a'))).toBe('child-a');
        expect(childIdFromSearchParams(new URLSearchParams('studentKey=self'))).toBeNull();
        expect(childIdFromSearchParams(new URLSearchParams('studentKey=child-b'))).toBe('child-b');
        expect(isUsableChildId('self')).toBe(false);
    });

    it('adds the right query key for each path', () => {
        expect(withChildParam('/review', 'child-a')).toBe('/review?learnerId=child-a');
        expect(withChildParam('/learn?tab=today', 'child-a')).toBe('/learn?tab=today&studentKey=child-a');
        expect(withChildParam('/notebooks/nb-1', 'child-a')).toBe('/notebooks/nb-1?learnerId=child-a');
        expect(withChildParam('/review', null)).toBe('/review');
    });

    it('reorders pages without mutating the original list', () => {
        const pages = ['a', 'b', 'c'];
        expect(moveItem(pages, 2, 0)).toEqual(['c', 'a', 'b']);
        expect(pages).toEqual(['a', 'b', 'c']);
        expect(moveItem(pages, 0, 2)).toEqual(['b', 'c', 'a']);
        expect(moveItem(pages, 1, 1)).toEqual(pages);
    });

    it('isolates stored child selection per userId', () => {
        const storage = new Map<string, string>();
        vi.stubGlobal('window', {
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => { storage.set(key, value); },
                removeItem: (key: string) => { storage.delete(key); },
            },
        });
        try {
            expect(currentChildStorageKey('user-a')).toBe(`${CURRENT_CHILD_STORAGE_KEY}:user-a`);
            writeStoredChild({ id: 'child-1', name: '大宝' }, 'user-a');
            writeStoredChild({ id: 'child-2', name: '二宝' }, 'user-b');

            expect(readStoredChild('user-a')).toEqual({ id: 'child-1', name: '大宝' });
            expect(readStoredChild('user-b')).toEqual({ id: 'child-2', name: '二宝' });

            writeStoredChild(null, 'user-a');
            expect(readStoredChild('user-a')).toBeNull();
            expect(readStoredChild('user-b')).toEqual({ id: 'child-2', name: '二宝' });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('HEIC detection', () => {
    it('detects HEIC by type or extension', () => {
        expect(isHeicFile({ type: 'image/heic', name: 'photo.jpg' })).toBe(true);
        expect(isHeicFile({ type: '', name: 'IMG_0001.HEIF' })).toBe(true);
        expect(isHeicFile({ type: 'image/jpeg', name: 'scan.jpg' })).toBe(false);
    });
});

describe('parent paper page images', () => {
    it('accepts jpeg data URLs and rejects other payloads', () => {
        expect(isPaperPageImage('data:image/jpeg;base64,AAAA')).toBe(true);
        expect(isPaperPageImage('data:image/png;base64,AAAA')).toBe(true);
        expect(isPaperPageImage('data:image/heic;base64,AAAA')).toBe(false);
        expect(isPaperPageImage('https://example.com/page.jpg')).toBe(false);
    });
});
