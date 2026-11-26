export type Violation = {
  userId: string;
  rule: string;
  action: string;
  channelId: string;
  messageId?: string;
  requestedAction?: string;
};
export type Raid = { state: "started" | "ended"; joinsPerMinute: number; measures: string[] };
