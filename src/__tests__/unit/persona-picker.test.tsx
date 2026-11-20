import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaPicker, togglePersona } from '@/components/persona-picker';
import { LanguageProvider } from '@/contexts/LanguageContext';
import type { Persona } from '@/lib/personas';

describe('togglePersona', () => {
    it('keeps two personas selected together', () => {
        const first = togglePersona(['teacher'], 'parent');
        expect(first).toEqual(['teacher', 'parent']);
        expect(togglePersona(first, 'self')).toEqual(['teacher', 'parent', 'self']);
        expect(togglePersona(first, 'teacher')).toEqual(['parent']);
    });
});

describe('PersonaPicker', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('renders square checkboxes, not radio buttons, and can show two selected at once', () => {
        const html = renderToStaticMarkup(
            <LanguageProvider>
                <PersonaPicker value={['teacher', 'parent']} onChange={() => undefined} />
            </LanguageProvider>,
        );
        expect(html).not.toContain('role="radio"');
        expect(html).not.toContain('type="radio"');
        expect(html).not.toContain('rounded-full');
        expect(html).toContain('role="checkbox"');
        expect(html).toContain('rounded-[3px]');
        expect(html).toContain('可以同时勾选多种身份');
        expect(html.match(/aria-checked="true"/g)?.length).toBe(2);
        expect(html).toContain('已选择');
    });

    it('selecting a second persona keeps the first so both can be saved together', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        let root: Root | null = null;
        const saved: Persona[][] = [];

        function Harness() {
            const [value, setValue] = useState<Persona[]>(['teacher']);
            return (
                <LanguageProvider>
                    <PersonaPicker
                        value={value}
                        onChange={(next) => {
                            saved.push(next);
                            setValue(next);
                        }}
                    />
                </LanguageProvider>
            );
        }

        await act(async () => {
            root = createRoot(container);
            root.render(<Harness />);
        });

        const parentCard = container.querySelector('[data-persona="parent"]') as HTMLButtonElement;
        expect(parentCard).toBeTruthy();
        await act(async () => {
            parentCard.click();
        });

        expect(saved.at(-1)).toEqual(['teacher', 'parent']);
        expect(container.querySelector('[data-persona="teacher"]')?.getAttribute('aria-checked')).toBe('true');
        expect(container.querySelector('[data-persona="parent"]')?.getAttribute('aria-checked')).toBe('true');
        expect(container.querySelectorAll('[aria-checked="true"]').length).toBe(2);

        await act(async () => {
            root?.unmount();
        });
        container.remove();
    });
});
