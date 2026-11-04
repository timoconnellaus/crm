/** A channel message to post through `SlackPostSession.post()`. */
export interface SlackPostMessage {
  /** A public channel's id (`C0123ABCD`) or name (`#sales` or `sales`). */
  channel: string;
  /** Message text in Slack mrkdwn, 1 to 4,000 characters. */
  text: string;
  /** The `ts` of the message to reply under, to post in its thread. */
  threadTs?: string;
  /**
   * CRM record ids the message is about (up to 20), shown to the approver. Provisional ids of
   * records created earlier in the same change set (such as `per_pending_…`) are fine.
   */
  relatedRecords?: string[];
}

/** A direct message to send through `SlackPostSession.dm()`. */
export interface SlackDirectMessage {
  /** The recipient's Slack user id (`U0123ABCD`) or email address. */
  user: string;
  /** Message text in Slack mrkdwn, 1 to 4,000 characters. */
  text: string;
  /** CRM record ids the message is about (up to 20), shown to the approver. */
  relatedRecords?: string[];
}

/** What `post()` and `dm()` return. The message waits for approval before it is sent. */
export interface SlackPostReceipt {
  status: "pending" | "posted";
  /** The post's id, as `listRecentPosts()` reports it. */
  id: number;
}

/** A public channel in the connected workspace. */
export interface SlackChannel {
  id: string;
  name: string;
  /** Whether the CRM's Slack app is a member (it can post only to channels it is in). */
  isMember: boolean;
  isArchived: boolean;
}

/** A Slack user. */
export interface SlackUser {
  id: string;
  /** The handle, without `@`. */
  name: string;
  realName?: string;
  displayName?: string;
}

/** One message in `listRecentPosts()`. */
export interface SlackPostRecord {
  id: number;
  kind: "post" | "dm";
  /** `#channel` for a post, the recipient's name or id for a DM. */
  target: string;
  /** The first 200 characters of the text. */
  text: string;
  /** `"pending"` awaits approval; `"rejected"` was turned down and never sent. */
  status: "pending" | "posted" | "rejected";
  /** Slack's message timestamp, once posted. */
  ts?: string;
  /** ISO 8601 time the message was posted. */
  postedAt?: string;
}

/**
 * Posts to one Slack workspace as the CRM's Slack app. Every message waits for approval before it
 * is sent. Reads reflect messages still awaiting approval.
 */
export interface SlackPostSession {
  /** Queues a channel message for approval. The app must be a member of the channel. */
  post(message: SlackPostMessage): Promise<SlackPostReceipt>;
  /** Queues a direct message for approval. */
  dm(message: SlackDirectMessage): Promise<SlackPostReceipt>;
  /** Lists the workspace's public channels (up to 1,000). */
  listChannels(): Promise<SlackChannel[]>;
  /** Finds a user by email address, or `null` when nobody in the workspace has it. */
  findUser(email: string): Promise<SlackUser | null>;
  /** Lists recent messages sent through this binding, newest first, pending ones included. */
  listRecentPosts(): Promise<SlackPostRecord[]>;
}
