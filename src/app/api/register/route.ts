import { NextResponse } from "next/server"
import { hash } from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { tooManyRequests } from "@/lib/api-errors"
import { getAppConfig } from "@/lib/config"
import { getClientIp, registerIpLimiter } from "@/lib/rate-limit"
import { defaultActivePersona, serializePersonas, uniquePersonas } from "@/lib/personas"
import { ChildLearnerLimitError, createChildLearner, MAX_CHILD_LEARNERS } from "@/lib/learners"

const userSchema = z.object({
    // 支持标准邮箱和本地邮箱（如 user@localhost）
    email: z.string().regex(/^[^\s@]+@[^\s@]+$/, "Invalid email format"),
    password: z.string().min(6),
    name: z.string().min(1),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional(),
    personas: z.array(z.string()).optional(),
    children: z.array(z.object({ name: z.string() })).optional(),
})

export async function POST(req: Request) {
    try {
        // 检查是否允许注册
        const config = getAppConfig();
        if (config.allowRegistration !== true) {
            return NextResponse.json(
                { user: null, message: "Registration is currently disabled" },
                { status: 403 }
            );
        }

        // 同一 IP 每小时提交次数有限，防止批量注册或枚举邮箱
        const ip = getClientIp(req.headers)
        if (ip) {
            const retryAfter = registerIpLimiter.retryAfter(ip)
            if (retryAfter > 0) {
                return tooManyRequests(retryAfter)
            }
            registerIpLimiter.hit(ip)
        }

        const body = await req.json()
        const { email, password, name, educationStage, enrollmentYear, personas: rawPersonas, children: rawChildren } = userSchema.parse(body)

        const existingUser = await prisma.user.findUnique({
            where: { email }
        })

        if (existingUser) {
            return NextResponse.json(
                { user: null, message: "User with this email already exists" },
                { status: 409 }
            )
        }

        const personas = uniquePersonas(rawPersonas)
        if (rawPersonas && rawPersonas.length > 0 && personas.length === 0) {
            return NextResponse.json(
                { user: null, message: "Invalid persona selection" },
                { status: 400 }
            )
        }
        const children = (rawChildren ?? [])
            .map((child) => ({ name: child.name.trim() }))
            .filter((child) => child.name.length > 0)
        if (children.length > 0 && !personas.includes("parent")) {
            return NextResponse.json(
                { user: null, message: "Children require the parent persona" },
                { status: 400 }
            )
        }
        if (children.length > MAX_CHILD_LEARNERS) {
            return NextResponse.json(
                { user: null, message: "At most 3 children" },
                { status: 400 }
            )
        }

        const hashedPassword = await hash(password, 10)
        const personaData = personas.length > 0
            ? {
                personas: serializePersonas(personas),
                activePersona: defaultActivePersona(personas, "self"),
                personasConfirmedAt: new Date(),
            }
            : {}
        const createData = {
            email,
            name,
            password: hashedPassword,
            educationStage,
            enrollmentYear,
            ...personaData,
        }
        const newUser = children.length > 0
            ? await prisma.$transaction(async (tx) => {
                const created = await tx.user.create({ data: createData })
                for (const child of children) {
                    await createChildLearner(tx, created.id, child.name)
                }
                return created
            })
            : await prisma.user.create({ data: createData })

        const { password: newUserPassword, ...rest } = newUser

        return NextResponse.json(
            { user: rest, message: "User created successfully" },
            { status: 201 }
        )
    } catch (error) {
        if (error instanceof ChildLearnerLimitError) {
            return NextResponse.json(
                { user: null, message: "At most 3 children" },
                { status: 400 }
            )
        }
        return NextResponse.json(
            { user: null, message: "Something went wrong" },
            { status: 500 }
        )
    }
}
