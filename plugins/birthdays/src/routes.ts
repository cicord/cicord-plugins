export interface Birthday {
  day: number;
  month: number;
}
export interface Routes {
  "GET /birthday": { response: { birthday: Birthday | null } };
  "PUT /birthday": { body: Birthday; response: { saved: true } };
  "DELETE /birthday": { response: { erased: number } };
}
