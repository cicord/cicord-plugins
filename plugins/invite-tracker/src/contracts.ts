export type InviteAttribution = { inviterId?: string; code?: string };
export type Joined = InviteAttribution & { userId: string; fake: boolean };
export type InviteCounts = { valid: number; fake: number; left: number };
