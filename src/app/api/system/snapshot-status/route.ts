import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { forbidden, unauthorized } from '@/lib/api-errors';
import { getDailySnapshotStatus, runDailySnapshot } from '@/lib/daily-snapshot';

export const dynamic = 'force-dynamic';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized();
    }
    return NextResponse.json(getDailySnapshotStatus(), {
        headers: { 'Cache-Control': 'no-store' },
    });
}

export async function POST() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized();
    }
    if (session.user.role !== 'admin') {
        return forbidden('Admin access required');
    }
    const status = await runDailySnapshot({ force: true });
    return NextResponse.json(status, {
        status: status.lastError ? 500 : 200,
        headers: { 'Cache-Control': 'no-store' },
    });
}
