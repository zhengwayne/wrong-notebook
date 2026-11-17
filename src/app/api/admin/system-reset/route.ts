import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { internalError, unauthorized, forbidden } from "@/lib/api-errors";
import { authOptions } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { performSystemReset } from "@/lib/system-reset";

const logger = createLogger('api:admin:system-reset');

export async function POST() {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    if (session.user.role !== 'admin') {
        return forbidden("Admin access required for system reset");
    }

    try {
        logger.info({ email: session.user.email }, 'System reset initiated');
        await performSystemReset(prisma, { id: session.user.id, email: session.user.email });
        logger.info('System reset completed successfully');
        return NextResponse.json({ success: true, message: "System reset complete" });
    } catch (error) {
        logger.error({ error }, 'System reset error');
        return internalError("Failed to reset system");
    }
}
