/**
 * OPT-21 API 鉴权清单双向一致性护栏：
 * 1) 磁盘 src/app/api 下的每个 route.ts 必须在 api-auth-inventory.json 中登记且一一对应；
 * 2) 除 NextAuth 自身处理入口外，API 路由严禁直接调用 getServerSession；
 * 3) 受保护路由必须显式走 defineApiRoute 或 getCurrentUser 统一鉴权链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '@/lib/server/api-auth-inventory.json';

interface InventoryEntry {
    auth: 'public' | 'optional' | 'user' | 'admin' | 'user_or_admin' | 'auth_provider' | 'custom_key_or_credentials';
    mechanism: string;
    unauthenticatedStatus?: number;
}

const API_ROOT = path.resolve('src/app/api');

function collectRouteFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectRouteFiles(fullPath, out);
        } else if (entry.isFile() && entry.name === 'route.ts') {
            const rel = path.relative(API_ROOT, dir).replace(/\\/g, '/');
            out.push(rel);
        }
    }
    return out;
}

describe('OPT-21 API 鉴权清单护栏', () => {
    const routesMap = inventory.routes as Record<string, InventoryEntry>;
    const diskRoutes = collectRouteFiles(API_ROOT).sort();
    const inventoryRoutes = Object.keys(routesMap).sort();

    it('磁盘所有 API 路由与 api-auth-inventory.json 完全双向匹配', () => {
        expect(diskRoutes).toEqual(inventoryRoutes);
        expect(diskRoutes.length).toBeGreaterThanOrEqual(109);
    });

    it('除 NextAuth 外所有 API 路由禁止直接调用 getServerSession 且必须匹配登记鉴权方式', () => {
        for (const rel of diskRoutes) {
            const entry = routesMap[rel];
            const source = fs.readFileSync(path.join(API_ROOT, rel, 'route.ts'), 'utf8');

            if (rel !== 'auth/[...nextauth]') {
                expect(source, `${rel} 不得直接引用 getServerSession`).not.toContain('getServerSession');
            }

            if (entry.mechanism === 'defineApiRoute') {
                expect(source, `${rel} 应使用 defineApiRoute`).toContain('defineApiRoute');
                if (entry.auth === 'admin') {
                    expect(source, `${rel} 应使用 admin 策略`).toMatch(/auth:\s*['"]admin['"]/);
                } else if (entry.auth === 'optional') {
                    expect(source, `${rel} 应使用 optional 策略`).toMatch(/auth:\s*['"]optional['"]/);
                }
            } else if (entry.mechanism === 'getCurrentUser') {
                expect(source, `${rel} 应使用 getCurrentUser`).toContain('getCurrentUser');
            }
        }
    });
});
