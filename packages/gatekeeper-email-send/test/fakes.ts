// State shared by the test Worker's fakes and the test files. Both run in one isolate, so the
// module instance is shared.

import type {
  ActionDescription,
  ObservationDescription,
} from "@crm/gatekeeper-interface/gatekeeper";
import type { OutgoingEmail } from "../src/transport";

/** Every email the fake Email Service binding received, in order. */
export const sentEmails: OutgoingEmail[] = [];

/** Every action the fake approval queue received, as `[id, description]`. */
export const submissions: [number, ActionDescription][] = [];

/** Every observation the fake approval queue authorized. */
export const observations: ObservationDescription[] = [];

/** Knobs for the fake Email Service binding. */
export const fakeEmail = { failNext: false };

export function resetFakes(): void {
  sentEmails.length = 0;
  submissions.length = 0;
  observations.length = 0;
  fakeEmail.failNext = false;
}
