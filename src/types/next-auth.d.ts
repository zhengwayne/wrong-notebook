import { DefaultSession } from "next-auth"
import type { Persona } from "@/lib/personas"

declare module "next-auth" {
    interface Session {
        user: {
            id: string
            role?: string
            /** 管理员仍在使用默认密码，必须先修改 */
            mustChangePassword?: boolean
            personas?: Persona[]
            activePersona?: Persona | null
            needsPersonaConfirmation?: boolean
        } & DefaultSession["user"]
    }

    interface User {
        role?: string
        isActive?: boolean
        mustChangePassword?: boolean
        personas?: Persona[]
        activePersona?: Persona | null
        needsPersonaConfirmation?: boolean
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        id: string
        role?: string
        mustChangePassword?: boolean
        personas?: Persona[]
        activePersona?: Persona | null
        needsPersonaConfirmation?: boolean
    }
}
