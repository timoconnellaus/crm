// Email from the control plane: sign-in links and billing/lifecycle notices. Live mode sends with
// Cloudflare Email Service's `send_email` binding; fake mode keeps the message in cp_dev_mail,
// readable at /dev/mail (fake mode only), which the e2e test uses to follow sign-in links.
import { newId } from "./util.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function liveMailer(binding: SendEmail, from: string): Mailer {
  return {
    async send(mail) {
      // The `send()` shape of Email Service (as used by gatekeeper-email-send).
      await (
        binding as unknown as {
          send(message: {
            from: string;
            to: string[];
            subject: string;
            text: string;
          }): Promise<unknown>;
        }
      ).send({ from, to: [mail.to], subject: mail.subject, text: mail.text });
    },
  };
}

export function fakeMailer(db: D1Database, now: () => Date): Mailer {
  return {
    async send(mail) {
      await db
        .prepare(
          "INSERT INTO cp_dev_mail (id, to_address, subject, body, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(newId("mail"), mail.to.toLowerCase(), mail.subject, mail.text, now().toISOString())
        .run();
    },
  };
}
