export type Grant = { userId: string; role: string; durationSeconds: number; reason?: string };
export type Revoke = { userId: string; role: string; reason?: string };
export type TempRoleExpired = { userId: string; roleId: string; expiresAt: number };
