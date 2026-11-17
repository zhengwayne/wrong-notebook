import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { badRequest, createErrorResponse, ErrorCode, tooManyRequests, unauthorized, validationError } from '@/lib/api-errors';
import { createLogger } from '@/lib/logger';
import { frontendLogLimiter } from '@/lib/rate-limit';

const logger = createLogger('frontend-logs');

// 单次请求体最大字节数、最多日志条数、单条消息与 extra 序列化上限
const MAX_REQUEST_BYTES = 65536;
const MAX_LOGS_PER_REQUEST = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONTEXT_BYTES = 2048;

export const runtime = 'nodejs';

const logEntrySchema = z.object({
  level: z.enum(['info', 'warn', 'error']).default('info'),
  prefix: z.string().max(100).default(''),
  message: z.string().max(20000),
  context: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().max(64).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
}).strip();

const payloadSchema = z.union([
  z.object({
    logs: z.array(logEntrySchema).min(1).max(200),
  }).strip(),
  logEntrySchema,
]);

type FrontendLogEntry = z.infer<typeof logEntrySchema>;

class PayloadTooLargeError extends Error {
  constructor() {
    super('Payload too large');
  }
}

/** 流式读取请求体并在超过上限时立即中断 */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new PayloadTooLargeError();
    }
    return text;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new PayloadTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function sanitizeExtraContext(context: Record<string, unknown> | undefined): unknown {
  if (!context || Object.keys(context).length === 0) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(context);
  } catch {
    return { unserializable: true };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_CONTEXT_BYTES) {
    return context;
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    preview: serialized.slice(0, MAX_CONTEXT_BYTES),
  };
}

/**
 * POST /api/logs/frontend
 *
 * Receives frontend logs and writes them to backend logger
 * Supports both single log and batch log formats.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return unauthorized('Authentication required');
  }

  const rateKey = session.user.id || session.user.email || 'anonymous';
  const retryAfter = frontendLogLimiter.retryAfter(rateKey);
  if (retryAfter > 0) {
    return tooManyRequests(retryAfter);
  }
  frontendLogLimiter.hit(rateKey);

  let rawText: string;
  try {
    rawText = await readBodyWithinLimit(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return createErrorResponse('Payload too large', 413, ErrorCode.BAD_REQUEST);
    }
    logger.error({ error }, 'Failed to read frontend log body');
    return badRequest('Invalid request body');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return badRequest('Invalid JSON body');
  }

  const validated = payloadSchema.safeParse(parsedJson);
  if (!validated.success) {
    return validationError('Invalid log payload', validated.error.issues);
  }

  const rawLogs: FrontendLogEntry[] = 'logs' in validated.data ? validated.data.logs : [validated.data];
  const logs = rawLogs.slice(0, MAX_LOGS_PER_REQUEST);

  for (const entry of logs) {
    const { level, prefix, context, timestamp, url, userAgent } = entry;
    const message = entry.message.slice(0, MAX_MESSAGE_LENGTH);
    const extra = sanitizeExtraContext(context);

    // 顶层元数据固定写死在服务端，前端 context 一律隔离到 extra 字段
    const logContext = {
      source: 'frontend' as const,
      prefix,
      url: url || request.headers.get('referer')?.slice(0, 500) || undefined,
      userAgent: userAgent || request.headers.get('user-agent')?.slice(0, 300) || undefined,
      clientTime: timestamp,
      userId: session.user.id,
      ...(extra !== undefined ? { extra } : {}),
    };

    switch (level) {
      case 'error':
        logger.error(logContext, message);
        break;
      case 'warn':
        logger.warn(logContext, message);
        break;
      case 'info':
      default:
        logger.info(logContext, message);
        break;
    }
  }

  return NextResponse.json({ success: true, count: logs.length });
}
