/** Payload of the `polls.closed` event. */
export interface PollClosedV1 {
  pollId: string;
  question: string;
  choices: { label: string; votes: number }[];
  winners: string[];
  voters: string[];
  closedBy: string | null;
  channelId: string;
  messageId: string;
}

export type PollClosedV2 = Omit<PollClosedV1, "voters"> & {
  voters?: string[];
  voterCount: number;
  votersTruncated?: boolean;
};
export type VotersInput = {
  pollId: string;
  cursor?: string;
  publisher?: { bot: string; instance: string };
};
export type VotersPage = { userIds: string[]; cursor?: string };
