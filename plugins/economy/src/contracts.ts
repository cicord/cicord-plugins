export type Transaction = {
  id: string;
  userId: string;
  amount: number;
  balance: number;
  reason: string;
};
export type Movement = { userId: string; amount: number; reason?: string };
