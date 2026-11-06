// The channel seam (ADR 0340; stage 17 "Out of scope"): how a thread reaches the person somewhere
// other than the app (SMS, WhatsApp, a phone call). Only the interface exists. The app itself is
// the first channel: its WebSocket and HTTP routes deliver every message.
import type { MessageVia, ThreadMessage } from "./thread.ts";

/** What a channel can show, so a reply can be shaped for it (cards, a short spoken version). */
export interface ChannelCapabilities {
  /** Rich cards (A2UI); otherwise their text fallbacks are sent. */
  cards: boolean;
  /** Markdown; otherwise plain text. */
  markdown: boolean;
  /** Audio out (the reply is spoken). */
  voice: boolean;
  /** The longest message the channel takes, in characters, if it has a limit. */
  maxLength?: number;
}

/** A message from the person arriving through a channel. */
export interface InboundMessage {
  channel: string;
  /** The person, as the channel's binding has resolved them. */
  userId: string;
  text: string;
  via: MessageVia;
  receivedAt: string;
}

export interface Channel {
  /** A stable id, e.g. `app`, `sms:+61…`. */
  id: string;
  kind: string;
  capabilities: ChannelCapabilities;
  /** Sends a thread message out. Resolves when the channel has accepted it. */
  deliver(message: ThreadMessage): Promise<void>;
}

/** Where inbound messages go: the thread's turn engine. */
export interface ChannelSink {
  receive(message: InboundMessage): Promise<void>;
}
