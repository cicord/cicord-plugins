export interface RoomCreated {
  channelId: string;
  ownerId: string;
}
export interface RoomClosed extends RoomCreated {
  durationMinutes?: number;
  peak?: number;
}
