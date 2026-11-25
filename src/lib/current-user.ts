import { resolveActor } from '@/lib/server/actor';
import { setRequestContextUserId } from '@/lib/server/request-context';

/**
 * 获取当前已登录且处于激活状态（且会话未被撤销）的用户；
 * 统一委托给 resolveActor 以确保 57+ 个现有路由同步获得 authVersion 与 isActive 实时校验。
 * 传入 req 时直接从该请求读取小程序 Bearer 令牌（不依赖 Next 请求作用域）。
 */
export async function getCurrentUser(req?: Request) {
    const actor = await resolveActor(req);
    if (actor.kind === 'authenticated') {
        setRequestContextUserId(actor.user.id);
        return actor.user;
    }
    return null;
}
