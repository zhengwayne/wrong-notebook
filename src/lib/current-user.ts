import { resolveActor } from '@/lib/server/actor';

/**
 * 获取当前已登录且处于激活状态（且会话未被撤销）的用户；
 * 统一委托给 resolveActor 以确保 57+ 个现有路由同步获得 authVersion 与 isActive 实时校验。
 */
export async function getCurrentUser() {
    const actor = await resolveActor();
    return actor.kind === 'authenticated' ? actor.user : null;
}
