import { NextResponse } from "next/server";
import { internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { performSystemReset } from "@/lib/system-reset";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:admin:system-reset');

export const POST = defineApiRoute({ auth: 'admin' }, async (_req, { user }) => {
    try {
        logger.info({ email: user.email }, 'System reset initiated');
        await performSystemReset(prisma, { id: user.id, email: user.email });
        logger.info('System reset completed successfully');
        return NextResponse.json({ success: true, message: "System reset complete" });
    } catch (error) {
        logger.error({ error }, 'System reset error');
        return internalError("Failed to reset system");
    }
});
