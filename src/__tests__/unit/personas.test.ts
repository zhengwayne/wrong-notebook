import { describe, expect, it } from 'vitest';
import {
    defaultActivePersona,
    defaultPreselect,
    isPersona,
    landingPath,
    needsPersonaConfirmation,
    parsePersonas,
    serializePersonas,
    SIGNUP_PRESELECT,
    uniquePersonas,
} from '@/lib/personas';
import { navItemsForPersona, mobilePrimaryItemsForPersona } from '@/lib/nav-items';

describe('personas helpers', () => {
    it('parses and de-duplicates personas in a stable order', () => {
        expect(parsePersonas('["parent","teacher","parent","self"]')).toEqual(['teacher', 'parent', 'self']);
        expect(parsePersonas('not-json')).toEqual([]);
        expect(parsePersonas(undefined)).toEqual([]);
        expect(serializePersonas(['self', 'teacher', 'self'])).toBe('["teacher","self"]');
        expect(uniquePersonas(['nope', 'parent', 'parent'])).toEqual(['parent']);
        expect(isPersona('teacher')).toBe(true);
        expect(isPersona('admin')).toBe(false);
    });

    it('preselects teacher only when the account already has a class', () => {
        expect(defaultPreselect(true)).toBe('teacher');
        expect(defaultPreselect(false)).toBe('self');
        expect(SIGNUP_PRESELECT).toBe('self');
    });

    it('picks an active persona from the confirmed set without inventing one', () => {
        expect(defaultActivePersona(['teacher', 'self'], 'teacher')).toBe('teacher');
        expect(defaultActivePersona(['parent'], 'self')).toBe('parent');
        expect(defaultActivePersona([], 'self')).toBeNull();
    });

    it('maps each persona to a landing path', () => {
        expect(landingPath('teacher')).toBe('/teacher');
        expect(landingPath('parent')).toBe('/parent');
        expect(landingPath('self')).toBe('/');
        expect(landingPath(null)).toBe('/');
        expect(needsPersonaConfirmation(null)).toBe(true);
        expect(needsPersonaConfirmation(new Date())).toBe(false);
    });
});

describe('persona navigation', () => {
    it('emphasises grading, classes and stats for teachers', () => {
        const keys = navItemsForPersona('teacher').map((item) => item.key);
        expect(keys.slice(0, 3)).toEqual(['grading', 'classes', 'stats']);
        expect(mobilePrimaryItemsForPersona('teacher').map((item) => item.key)).toEqual(['grading', 'classes', 'stats', 'notebooks']);
    });

    it('emphasises children, tasks, practice and path for parents, and hides grading', () => {
        const items = navItemsForPersona('parent');
        expect(items.map((item) => item.key).slice(0, 4)).toEqual(['children', 'todayTasks', 'practice', 'path']);
        expect(items.some((item) => item.key === 'grading')).toBe(false);
        expect(mobilePrimaryItemsForPersona('parent').map((item) => item.key)).toEqual(['children', 'todayTasks', 'practice', 'path']);
    });

    it('keeps the current layout for self-study', () => {
        expect(navItemsForPersona('self').map((item) => item.key)).toEqual([
            'home', 'notebooks', 'review', 'learn', 'stats', 'exams', 'grading',
        ]);
    });
});
