export type Status = "open" | "considered" | "approved" | "denied" | "implemented";
export type SuggestionEvent = { id: string; authorId: string; status: Status; score: number };
