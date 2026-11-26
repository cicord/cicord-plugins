export type LedgerRow = {
  id: string;
  userId: string;
  amount: number;
  balance: number;
  reason: string;
  at: number;
};
export interface Routes {
  "GET /wallet": { response: { balance: number } };
  "GET /history": { query: { cursor?: string }; response: { items: LedgerRow[]; cursor?: string } };
  "GET /ledger": { query: { cursor?: string }; response: { items: LedgerRow[]; cursor?: string } };
  "POST /shop/:id/buy": {
    body: { purchaseId: string };
    response: { orderId: string; itemId: string; state: "pending" | "delivered" };
  };
  "GET /shop": { response: { items: { id: string; label: string; price: number }[] } };
}
