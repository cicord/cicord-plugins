import type { PollClosed } from "./polls.ts";
export type PollClosedV1 = PollClosed;
export type PollClosedV2 = Omit<PollClosed, "voters"> & {
  voters?: string[];
  voterCount: number;
  votersTruncated?: boolean;
};
export type VotersInput = { pollId: string; cursor?: string };
export type VotersPage = { userIds: string[]; cursor?: string };
