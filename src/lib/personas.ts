/**
 * 使用身份（persona）与账户角色（admin/user）分开：
 * role 仍表示权限；persona 表示老师 / 家长 / 自学，可多选，同一时间只用一个 activePersona。
 */
export const PERSONAS = ['teacher', 'parent', 'self'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERSONA_LABEL_KEY = {
    teacher: 'teacher',
    parent: 'parent',
    self: 'self',
} as const;

export function isPersona(value: unknown): value is Persona {
    return typeof value === 'string' && (PERSONAS as readonly string[]).includes(value);
}

export function parsePersonas(raw: string | null | undefined): Persona[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const seen = new Set<Persona>();
        for (const item of parsed) {
            if (isPersona(item) && !seen.has(item)) seen.add(item);
        }
        return PERSONAS.filter((p) => seen.has(p));
    } catch {
        return [];
    }
}

export function serializePersonas(personas: readonly Persona[]): string {
    const unique = PERSONAS.filter((p) => personas.includes(p));
    return JSON.stringify(unique);
}

export function uniquePersonas(list: unknown): Persona[] {
    if (!Array.isArray(list)) return [];
    const seen = new Set<Persona>();
    for (const item of list) {
        if (isPersona(item) && !seen.has(item)) seen.add(item);
    }
    return PERSONAS.filter((p) => seen.has(p));
}

/** 已有账户首次确认：有班级则预选老师，否则预选自学。不会自动提交。 */
export function defaultPreselect(hasGradingClass: boolean): Persona {
    return hasGradingClass ? 'teacher' : 'self';
}

/** 新注册默认预选自学 */
export const SIGNUP_PRESELECT: Persona = 'self';

export function defaultActivePersona(selected: readonly Persona[], preselect?: Persona | null): Persona | null {
    if (selected.length === 0) return null;
    if (preselect && selected.includes(preselect)) return preselect;
    if (selected.includes('self')) return 'self';
    return selected[0];
}

export function landingPath(persona: Persona | null | undefined): string {
    if (persona === 'teacher') return '/teacher';
    if (persona === 'parent') return '/parent';
    return '/';
}

export function needsPersonaConfirmation(confirmedAt: Date | string | null | undefined): boolean {
    return confirmedAt == null;
}
