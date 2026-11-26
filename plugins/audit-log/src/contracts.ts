/** Only attributed, bounded metadata from these contracts is displayed. */
export type CaseNotice = {
  number: number;
  action: string;
  member?: { id: string };
  moderator?: { id: string };
};
export type PollNotice = {
  pollId: string;
  channelId?: string;
  voterCount?: number;
  votersTruncated?: boolean;
};
export type PartnerNotice = {
  id?: string;
  number?: number;
  case?: number;
  userId?: string;
  memberId?: string;
  authorId?: string;
  actorId?: string;
  ownerId?: string;
  by?: string;
  channelId?: string;
  messageId?: string;
  status?: string;
  action?: string;
  method?: string;
  state?: string;
  level?: number;
};
