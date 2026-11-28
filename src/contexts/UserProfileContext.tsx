"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { apiClient } from "@/lib/api-client";
import type { UpdateUserProfileRequest, UserProfile } from "@/types/api";

export interface UserProfileContextValue {
    profile: UserProfile | null;
    loading: boolean;
    error: unknown;
    refresh: () => Promise<UserProfile | null>;
    patchProfile: (patch: UpdateUserProfileRequest) => Promise<UserProfile>;
}

const UserProfileContext = createContext<UserProfileContextValue | null>(null);

/** 设置面板共享当前登录用户的个人资料与偏好，避免打开设置时重复请求 /api/user */
export function UserProfileProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<unknown>(null);
    const inFlightRef = useRef<Promise<UserProfile | null> | null>(null);

    const refresh = useCallback(async () => {
        if (inFlightRef.current) return inFlightRef.current;
        setLoading(true);
        setError(null);
        const task = apiClient.get<UserProfile>("/api/user")
            .then((data) => {
                setProfile(data);
                return data;
            })
            .catch((err) => {
                setError(err);
                return null;
            })
            .finally(() => {
                inFlightRef.current = null;
                setLoading(false);
            });
        inFlightRef.current = task;
        return task;
    }, []);

    useEffect(() => {
        if (!enabled) return;
        void refresh();
    }, [enabled, refresh]);

    const patchProfile = useCallback(async (patch: UpdateUserProfileRequest) => {
        const updated = await apiClient.patch<UserProfile>("/api/user", patch);
        setProfile((prev) => ({ ...(prev ?? {}), ...updated } as UserProfile));
        return updated;
    }, []);

    return (
        <UserProfileContext.Provider value={{
            profile,
            loading: loading || (enabled && profile === null && error === null),
            error,
            refresh,
            patchProfile,
        }}>
            {children}
        </UserProfileContext.Provider>
    );
}

export function useOptionalUserProfile(): UserProfileContextValue | null {
    return useContext(UserProfileContext);
}
