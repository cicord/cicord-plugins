export interface Verified {
  userId: string;
  method: string;
}
export interface Inviter {
  inviterId?: string;
  code?: string;
}
