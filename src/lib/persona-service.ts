import type { Prisma, PrismaClient } from '@prisma/client';
import {
    defaultActivePersona,
    serializePersonas,
    uniquePersonas,
    type Persona,
} from '@/lib/personas';
import { ChildLearnerLimitError, createChildLearner, MAX_CHILD_LEARNERS } from '@/lib/learners';

type Db = PrismaClient | Prisma.TransactionClient;

export class PersonaSelectionError extends Error {
    constructor(message = 'PERSONA_REQUIRED') {
        super(message);
        this.name = 'PersonaSelectionError';
    }
}

export async function hasGradingClass(db: Db, userId: string): Promise<boolean> {
    const count = await db.gradingClass.count({ where: { userId } });
    return count > 0;
}

export async function applyPersonaSelection(
    db: Db,
    userId: string,
    input: {
        personas: unknown;
        activePersona?: unknown;
        preselect?: Persona | null;
        children?: { name: string }[];
        confirm?: boolean;
    },
): Promise<{ personas: Persona[]; activePersona: Persona; confirmed: boolean }> {
    const personas = uniquePersonas(input.personas);
    if (personas.length === 0) throw new PersonaSelectionError();
    const activePersona = defaultActivePersona(
        personas,
        typeof input.activePersona === 'string' ? (input.activePersona as Persona) : input.preselect,
    );
    if (!activePersona) throw new PersonaSelectionError();

    const children = (input.children ?? [])
        .map((child) => ({ name: child.name.trim() }))
        .filter((child) => child.name.length > 0);
    if (children.length > 0 && !personas.includes('parent')) {
        throw new PersonaSelectionError('CHILDREN_REQUIRE_PARENT');
    }
    if (children.length > MAX_CHILD_LEARNERS) throw new ChildLearnerLimitError();

    const data: Prisma.UserUpdateInput = {
        personas: serializePersonas(personas),
        activePersona,
    };
    if (input.confirm) {
        data.personasConfirmedAt = new Date();
    }

    await db.user.update({ where: { id: userId }, data });

    if (children.length > 0) {
        for (const child of children) {
            await createChildLearner(db, userId, child.name);
        }
    }

    return { personas, activePersona, confirmed: Boolean(input.confirm) };
}
