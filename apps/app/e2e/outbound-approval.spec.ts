// Outbound approvals (stage 6a, ADR 0051): an agent asks a connected gatekeeper to send an email
// (the curated integration_call MCP tool on a fake outbox). It is not sent: it waits in Approvals
// with the gatekeeper's own preview (title, kind, To, Subject, body). Approving it sends it.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionId,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";
import { call, connectApp } from "./mcp.ts";

test("an outbound email waits for approval and is sent when approved", async ({
  page,
  request,
  baseURL,
}) => {
  const token = unique();
  const address = fakeAddress("outbox");
  const recipient = `someone-${token}@ext.test`.toLowerCase();
  const subject = `Proposal ${token}`;

  await openIntegrations(page);
  const connection = await connectFake(page, address);
  await addFakeResource(page, connection, "Outbox", address);
  const id = await connectionId(connection);
  const binding = (
    (await connection.getByTestId("connection-resource").locator("code").textContent()) ?? ""
  ).trim();
  expect(binding).not.toBe("");

  // An agent sends mail through the connection: it is queued, not sent.
  const app = await connectApp(page, baseURL ?? "");
  const out = await call(app.client, "integration_call", {
    connectionId: id,
    resource: binding,
    method: "send",
    args: [{ to: [recipient], subject, text: `Hi,\n\nHere is the **proposal** (${token}).` }],
    reason: "Follow up on the call",
  });
  expect(Array.isArray(out.pending) && out.pending.length).toBeTruthy();
  expect(await sentMail(request, address)).toEqual([]);

  // The connection shows it waiting.
  await openIntegrations(page);
  await expect(
    page.getByTestId("connection").filter({ hasText: address }).getByTestId("pending-outbound"),
  ).toContainText("1 outbound action waiting (simulated)");

  // Approvals shows the gatekeeper's preview.
  await open(page, "/approvals");
  const action = page
    .getByTestId("pending-action")
    .filter({ has: page.getByTestId("outbound-preview").filter({ hasText: subject }) });
  await expect(action).toBeVisible();
  await expect(action.getByTestId("risk-badge")).toHaveText("outbound");
  const preview = action.getByTestId("outbound-preview");
  await expect(preview.getByTestId("outbound-kind")).toHaveText("Send mail");
  const fields = preview.getByTestId("outbound-fields");
  await expect(fields).toContainText("To");
  await expect(fields).toContainText(recipient);
  await expect(fields).toContainText("Subject");
  await expect(fields).toContainText(subject);
  // The body field is shown verbatim (Markdown source, not rendered).
  await expect(fields).toContainText("**proposal**");
  await expectNoHorizontalScroll(page);

  const set = page.getByTestId("change-set").filter({ has: action });
  await set.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(set.getByTestId("decision-result")).toContainText("Applied 1 change");
  await expect(action).toHaveAttribute("data-status", "applied");

  // It was actually sent.
  await expect
    .poll(async () => (await sentMail(request, address)).map((m) => m.subject))
    .toContain(subject);
  const [sent] = await sentMail(request, address);
  expect(sent?.to).toEqual([recipient]);
});
