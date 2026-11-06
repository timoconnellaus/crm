// Voice (ADR 0349) against the stand-in speech providers (AI_FAKE_VOICE): first-use setup, a spoken
// turn in the one thread, barge-in, push to talk, dictation with its cleanup and undo, and
// Settings → Voice. Chromium's fake microphone stands in for the person, and window.__voiceSay and
// window.__dictationSay speak into the stand-in transcriber.
import { expect, type Page, test } from "@playwright/test";
import { isPhone, open } from "./helpers.ts";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function openPanel(page: Page) {
  const panel = page.getByTestId("assistant-panel");
  if (isPhone(page)) {
    await page.getByTestId("open-assistant").click();
  } else {
    await expect(async () => {
      if (!(await panel.isVisible())) await page.keyboard.press("ControlOrMeta+j");
      await expect(panel).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
  }
  return panel;
}

/** Starts voice chat, going through first-use setup when it has not run yet. */
async function startCall(page: Page, mode: "hands_free" | "push_to_talk") {
  await page.getByTestId("voice-chat-start").first().click();
  const setup = page.getByTestId("voice-setup");
  const bar = page.getByTestId("voice-bar").first();
  await expect(setup.or(bar)).toBeVisible();
  if (await setup.isVisible()) {
    // AssemblyAI-TTS-1 has no speed control, so setup asks for voice and mode only.
    await expect(setup.getByLabel(/^Speed/)).toHaveCount(0);
    // Click the label, as a person does: the radio is a 1px sr-only input, and a forced check of
    // it fails while the dialog zooms in, because Playwright doesn't wait and it measures under 1px.
    const radio = setup.getByTestId(`voice-mode-${mode}`);
    await radio.locator("xpath=ancestor::label[1]").click();
    await expect(radio).toBeChecked();
    await setup.getByTestId("voice-start").click();
  }
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-status", "listening");
  if ((await bar.getAttribute("data-mode")) !== mode) {
    await bar.getByTestId("voice-switch-mode").click();
    await expect(bar).toHaveAttribute("data-mode", mode);
  }
  return bar;
}

const say = (page: Page, text: string) =>
  page.evaluate((t) => (window as never as { __voiceSay(t: string): void }).__voiceSay(t), text);

test("a spoken turn lands in the thread in italics, and speaking over a reply is recorded", async ({
  page,
}) => {
  await open(page, "/");
  const panel = await openPanel(page);
  const bar = await startCall(page, "hands_free");

  await say(page, "whats on my list today");
  const message = panel.getByTestId("assistant-user").last();
  await expect(message).toContainText("whats on my list today");
  await expect(message.locator("[data-via=voice]")).toHaveClass(/italic/);
  await expect(message.getByRole("img", { name: "Spoken" })).toBeVisible();
  const reply = panel.getByTestId("assistant-reply").last();
  await expect(reply).toContainText("Said:");
  await expect(reply).toContainText("Here is the short version.");
  await expect(reply).not.toContainText("<say>");

  await bar.getByTestId("voice-end").click();
  await expect(page.getByTestId("voice-bar")).toHaveCount(0);
});

test("speaking over a reply stops it, and the chat marks it partly heard", async ({ page }) => {
  // Read out in full, so there is plenty of reply to speak over.
  await open(page, "/settings/voice");
  await page.getByTestId("voice-read-full").click();
  await expect(page.getByTestId("voice-read-full")).toBeChecked();
  await open(page, "/");
  const panel = await openPanel(page);
  const bar = await startCall(page, "hands_free");
  await say(page, "tell me what you can do");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText("I can look up");
  // Let some of it play. The turn stays open, so what is marked comes from the browser's report.
  await page.waitForTimeout(2_000);
  await say(page, "sorry which one was that...");
  await expect(panel.getByTestId("assistant-partly-heard").last()).toBeVisible();
  await bar.getByTestId("voice-end").click();
  await open(page, "/settings/voice");
  await page.getByTestId("voice-read-short").click();
  await expect(page.getByTestId("voice-read-short")).toBeChecked();
});

test("push to talk: nothing is heard until the button is held, and letting go ends the turn", async ({
  page,
}) => {
  await open(page, "/");
  const panel = await openPanel(page);
  const bar = await startCall(page, "push_to_talk");
  const hold = bar.getByTestId("voice-hold");
  await expect(hold).toHaveText("Hold to talk");
  const box = await hold.boundingBox();
  if (!box) throw new Error("no talk button");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(hold).toHaveText("Release to send");
  await say(page, "push to talk works...");
  await expect(bar.getByTestId("voice-status")).toContainText("push to talk works");
  await page.mouse.up();
  await expect(hold).toHaveText("Hold to talk");
  await expect(panel.getByTestId("assistant-user").last()).toContainText("push to talk works");
  await bar.getByTestId("voice-end").click();
});

test("the full-screen view on a phone reads the reply out and keeps its controls", async ({
  page,
}) => {
  test.skip(!isPhone(page), "the view is for phones");
  await open(page, "/");
  await openPanel(page);
  await startCall(page, "hands_free");
  await page.getByTestId("voice-fullscreen").first().click();
  const view = page.getByTestId("voice-fullscreen-view");
  await expect(view).toContainText("Cards aren't shown here");
  await say(page, "tell me what you can do");
  await expect(view).toContainText("I can look up");
  await expect(view).not.toContainText("short version");
  await view.getByTestId("voice-end").click();
  await expect(view).toHaveCount(0);
});

test("dictation types into the box, cleans up with undo, and sends as typed", async ({ page }) => {
  await open(page, "/");
  const panel = await openPanel(page);
  const input = panel.getByTestId("assistant-input");
  await panel.getByTestId("dictation-mic").click();
  await expect(panel.getByTestId("dictation-status")).toContainText("Esc to cancel");
  await expect.poll(() => page.evaluate(() => "__dictationSay" in window)).toBe(true);
  await expect(async () => {
    await page.evaluate(() =>
      (window as never as { __dictationSay(t: string): void }).__dictationSay(
        "um add a task to call Lena",
      ),
    );
    await expect(input).toHaveValue(/um add a task to call Lena/, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await panel.getByTestId("dictation-mic").click();
  await expect(input).toHaveValue("add a task to call Lena");
  await panel.getByTestId("dictation-undo").click();
  await expect(input).toHaveValue("um add a task to call Lena");
  await panel.getByTestId("assistant-send").click();
  const sent = panel.getByTestId("assistant-user").last();
  await expect(sent).toContainText("um add a task to call Lena");
  await expect(sent.locator("[data-via]")).not.toHaveClass(/italic/);
  await expect(sent.getByRole("img", { name: "Spoken" })).toHaveCount(0);
});

test("Settings → Voice: no speed, this device's mode, the device list", async ({ page }) => {
  await open(page, "/settings/voice");
  const settings = page.getByTestId("voice-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel(/^Speed/)).toHaveCount(0);
  // A new browser is a new device, and it joins the list when its mode is changed. Clicking the
  // mode it already has changes nothing, so pick the other one.
  const handsFree = settings.getByTestId("voice-mode-hands_free");
  const pushToTalk = settings.getByTestId("voice-mode-push_to_talk");
  const useHandsFree = !(await handsFree.isChecked());
  await (useHandsFree ? handsFree : pushToTalk).click({ force: true });
  const row = page.getByTestId("voice-devices").getByRole("row", { name: /This device/ });
  await expect(row).toContainText(useHandsFree ? "Hands-free" : "Push to talk");
  await settings.getByTestId("voice-read-full").click();
  await expect(settings.getByTestId("voice-read-full")).toBeChecked();
  await settings.getByTestId("voice-read-short").click();
  await expect(settings.getByTestId("voice-read-short")).toBeChecked();
});
