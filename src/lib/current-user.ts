import { resolveActor } from '@/lib/server/actor';
import { setRequestContextUserId } from '@/lib/server/request-context';

/**
 * 获取当前已登录且处于激活状态（且会话未被撤销）的用户；
 * 统一委托给 resolveActor 以确保 57+ 个现有路由同步获得 authVersion 与 isActive 实时校验。
 */
export async function getCurrentUser() {
    const actor = await resolveActor();
    if (actor.kind === 'authenticated') {
        setRequestContextUserId(actor.user.id);
        return actor.user;
    }
    return null;
}
