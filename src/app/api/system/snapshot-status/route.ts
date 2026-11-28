import { NextResponse } from 'next/server';
import { getDailySnapshotStatus, runDailySnapshot } from '@/lib/daily-snapshot';
import { defineApiRoute } from '@/lib/server/api-route';

export const dynamic = 'force-dynamic';

export const GET = defineApiRoute({ auth: 'user' }, async () => {
    return NextResponse.json(getDailySnapshotStatus(), {
        headers: { 'Cache-Control': 'no-store' },
    });
});

export const POST = defineApiRoute({ auth: 'admin' }, async () => {
    const status = await runDailySnapshot({ force: true });
    return NextResponse.json(status, {
        status: status.lastError ? 500 : 200,
        headers: { 'Cache-Control': 'no-store' },
    });
});
