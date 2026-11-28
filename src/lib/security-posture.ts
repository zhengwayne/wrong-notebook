import type { AppConfig, SecurityPosture } from '@/types/api';

const DEFAULT_DEV_NEXTAUTH_SECRET = 'supersecret-dev-secret';

/**
 * 解析当前部署的匿名安全态势摘要（仅向管理员展示，不含任何密钥明文）。
 */
export function getSecurityPosture(
    config: Pick<AppConfig, 'allowRegistration'>,
    env: NodeJS.ProcessEnv = process.env,
): SecurityPosture {
    const rawTrustProxy = env.TRUST_PROXY?.trim().toLowerCase();
    const trustProxyMode: SecurityPosture['trustProxyMode'] =
        rawTrustProxy === 'cloudflare'
            ? 'cloudflare'
            : rawTrustProxy === 'true'
                ? 'true'
                : rawTrustProxy === 'false'
                    ? 'false'
                    : 'unset';

    const parsedHops = Number.parseInt(env.TRUSTED_PROXY_HOPS || '1', 10);
    const trustedProxyHops = Number.isInteger(parsedHops) && parsedHops >= 1 ? parsedHops : 1;

    const secret = env.NEXTAUTH_SECRET || '';
    const defaultNextAuthSecret =
        !secret || secret === DEFAULT_DEV_NEXTAUTH_SECRET || secret.length < 32;

    const httpsConfigured =
        env.HTTPS_ENABLED === 'true' || Boolean(env.NEXTAUTH_URL?.trim().toLowerCase().startsWith('https://'));

    const openclawAuthMode: SecurityPosture['openclawAuthMode'] =
        env.OPENCLAW_AUTH_MODE === 'apikey' ? 'apikey' : 'credentials';
    const openclawKeyConfigured = Boolean(env.OPENCLAW_INTEGRATION_API_KEY?.trim());

    return {
        trustProxyMode,
        trustedProxyHops,
        defaultNextAuthSecret,
        httpsConfigured,
        registrationOpen: config.allowRegistration === true,
        openclawAuthMode,
        openclawKeyConfigured,
    };
}
