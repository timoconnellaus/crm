// The renderer handles every configurator spec the shipped gatekeepers use: each is loaded through
// the registry, server-rendered by ConfiguratorForm with a fake `ui`, and its `resourceUrl()` of
// minimally filled values matches the resource type's URLPattern.
import type {
  ConfiguratorUISpec,
  ConfiguratorUIValues,
} from "@relationship-os/gatekeeper-configurator-ui";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfiguratorForm } from "../src/components/integrations/configurator/configurator-form.tsx";
import {
  CONFIGURATORS,
  type ConfiguratorEntry,
  type ConfiguratorSpecName,
  configuratorEntryFor,
  configuratorSpecFor,
  loadConfiguratorSpec,
} from "../src/components/integrations/configurator/registry.ts";
import { uiProxy } from "../src/components/integrations/configurator/ui-proxy.ts";

type Methods = Record<string, (...args: unknown[]) => unknown>;
type Fixture = {
  ui?: Methods;
  /** Values filled in on top of the spec's `initial`, enough for `resourceUrl()`. */
  values?: ConfiguratorUIValues;
  /** Text the rendered form must contain. */
  expect: string[];
  /** Specs that load their state through `ui` first: rendered again once it has arrived. */
  twoPass?: boolean;
};

const OPTIONS = [{ value: "opt-1", title: "Option one", subtitle: "The first" }];
const OUTLOOK_READY = {
  state: "ready",
  me: { address: "me@contoso.com", name: "Me" },
  levels: ["read", "draft", "send"],
  sharedLevels: ["read"],
  limitedByDeployment: false,
};
const CALENDAR_READY = { ...OUTLOOK_READY, levels: ["read", "edit", "schedule"] };

const DRIVE_TARGETS: Record<string, string> = {
  "https://drive.google.com/drive/my-drive": "drive",
  "https://drive.google.com/drive/folders/:folderId": "folder:F1",
  "https://drive.google.com/file/d/:fileId/view": "file:X1",
  "https://docs.google.com/document/d/:docId/*": "doc:D1",
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*": "sheets:S1",
  "https://docs.google.com/presentation/d/:presentationId/*": "slides:P1",
};

function fixture(entry: ConfiguratorEntry): Fixture {
  const fixtures: Record<ConfiguratorSpecName, Fixture> = {
    "google/bigquery": {
      values: { projectId: "my-project" },
      expect: ["Project", "Dataset", "Table", 'role="combobox"'],
    },
    "google/calendar": {
      ui: { listCalendars: () => OPTIONS },
      values: { calendarId: "team@example.com" },
      expect: ["Calendar", "Availability lookup", 'role="combobox"', 'role="radiogroup"'],
    },
    "google/chat-account": {
      expect: ["Google Chat account", "All my Google Chat conversations", 'role="radiogroup"'],
    },
    "google/chat-space": {
      values: { spaceId: "AAAA" },
      expect: ["Conversation", 'role="combobox"'],
    },
    "google/chat-thread": {
      values: { link: "https://chat.google.com/room/AAAA/BBBB" },
      expect: ["Thread link", "<input"],
    },
    "google/drive": {
      ui: { listDriveNodes: () => ({ nodes: [], nextCursor: null }), getDriveNode: () => null },
      values: { target: DRIVE_TARGETS[entry.resourceUrlPattern] ?? "drive" },
      expect: ["What to connect", "All of Google Drive", "Search all of Drive"],
    },
    "google/gmail": { expect: ["Mailbox scope", "All Gmail", 'role="radiogroup"'] },
    "microsoft/outlook": {
      ui: {
        getStatus: () => OUTLOOK_READY,
        listFolders: () => ({ folders: [] }),
        findConversations: () => ({ items: [] }),
        resourceUrlFor: () => "https://outlook.office.com/mail/",
      },
      twoPass: true,
      expect: ["What to connect"],
    },
    "microsoft/calendar": {
      ui: {
        getStatus: () => CALENDAR_READY,
        listCalendars: () => [],
        resourceUrlFor: () => "https://outlook.office.com/calendar/view/month",
      },
      twoPass: true,
      expect: ["What to connect"],
    },
    "microsoft/sharepoint": {
      ui: {
        getStatus: () => ({ state: "ready", access: "read", tenant: "contoso" }),
        loadItems: () => ({ items: [] }),
        resourceUrlFor: () => "https://contoso.sharepoint.com/",
      },
      twoPass: true,
      expect: ["What to connect", "Sites", "OneDrive"],
    },
    "slack/workspace": {
      ui: { listWorkspaces: () => [{ value: "T123", title: "Acme" }] },
      values: { teamId: "T123" },
      expect: ["Workspace", 'role="combobox"'],
    },
    "slack/conversation": {
      values: { teamId: "T123", conversationId: "C123" },
      expect: ["Workspace", "Conversation", 'role="combobox"'],
    },
    "slack/thread": {
      values: { permalink: "https://acme.slack.com/archives/C123/p123456" },
      expect: ["Thread permalink", "<input"],
    },
    "mcp/server": {
      ui: {
        getEndpoint: () => `${entry.resourceUrlPattern.replace("*", "mcp.example.com")}/mcp`,
        listToolOptions: () => [{ value: "search", title: "search" }],
      },
      expect: ["Tools", "All tools", "Choose tools", "Allowed tools"],
    },
    "email/email": {
      ui: { resourceUrl: (name) => entry.resourceUrlPattern.replace(":user", String(name)) },
      values: { emailName: "alerts" },
      expect: ["Email name", "<input", 'placeholder="alerts"'],
    },
    "zoominfo/account": {
      ui: { resourceUrl: () => "https://api.zoominfo.com/" },
      expect: ["Whole-account access"],
    },
    "webhook/endpoint": {
      ui: { resourceUrl: (id) => `webhook://endpoint/${String(id)}` },
      values: { endpointId: "github-main" },
      expect: ["Endpoint id", "Signature scheme", "Generic HMAC-SHA256", "Save endpoint"],
    },
    "email-send/sender": {
      ui: { allowedDomains: () => ["example.com"] },
      values: { address: "crm@example.com" },
      expect: ["Sender address", "<input"],
    },
  };
  return fixtures[entry.spec];
}

function fakeUi(methods: Methods = {}, calls: string[] = []) {
  return uiProxy(async (method, args) => {
    calls.push(method);
    const implementation = methods[method];
    return implementation ? implementation(...args) : [];
  });
}

function render(spec: ConfiguratorUISpec<unknown>, ui: unknown, resourceUrlPattern: string) {
  return renderToString(
    createElement(ConfiguratorForm, {
      spec,
      ui,
      resourceUrlPattern,
      ensureResources: async () => true,
    }),
  );
}

/** Lets promise chains the render started (a status load, say) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("every configurator spec", () => {
  it("covers every spec the registry knows", () => {
    expect(new Set(CONFIGURATORS.map((entry) => entry.spec)).size).toBe(18);
  });

  for (const entry of CONFIGURATORS) {
    it(`${entry.vendor} ${entry.resourceUrlPattern} (${entry.spec}) renders and builds a matching URL`, async () => {
      const spec = await configuratorSpecFor(entry.vendor, entry.resourceUrlPattern);
      expect(spec).not.toBeNull();
      if (!spec) return;
      const { ui: methods, values, expect: shown, twoPass } = fixture(entry);
      const ui = fakeUi(methods);

      let html = render(spec, ui, entry.resourceUrlPattern);
      if (twoPass) {
        await settle();
        html = render(spec, ui, entry.resourceUrlPattern);
      }
      expect(html).not.toContain('role="alert"');
      for (const text of shown) expect(html).toContain(text);

      const url = await spec.resourceUrl({ values: { ...spec.initial, ...values }, ui });
      expect(typeof url).toBe("string");
      expect(new URLPattern(entry.resourceUrlPattern).test(url), url).toBe(true);
    });
  }
});

describe("the registry", () => {
  it("maps deployment-specific and catch-all patterns", () => {
    expect(
      configuratorEntryFor("email", "https://crm.example.com/gatekeeper/email/mailbox/:user")?.spec,
    ).toBe("email/email");
    expect(configuratorEntryFor("mcp", "https://*")?.spec).toBe("mcp/server");
    expect(configuratorEntryFor("mcp", "https://example.com/anything")?.spec).toBe("mcp/server");
    expect(configuratorEntryFor("slack", "https://*")?.spec).toBe("slack/workspace");
    expect(configuratorEntryFor("zoominfo", "https://*")?.spec).toBe("zoominfo/account");
    expect(
      configuratorEntryFor("google", "https://docs.google.com/spreadsheets/d/:spreadsheetId/*")
        ?.spec,
    ).toBe("google/drive");
  });

  it("has nothing for unknown vendors or resource types", async () => {
    expect(configuratorEntryFor("websearch", "https://*")).toBeNull();
    expect(configuratorEntryFor("google", "https://example.com/*")).toBeNull();
    expect(await configuratorSpecFor("nobody", "https://*")).toBeNull();
  });

  it("gives every form a fresh spec, its module state its own", async () => {
    const first = await loadConfiguratorSpec("microsoft/sharepoint");
    const second = await loadConfiguratorSpec("microsoft/sharepoint");
    expect(first).not.toBe(second);
    const calls: string[] = [];
    const entry = CONFIGURATORS.find((candidate) => candidate.spec === "microsoft/sharepoint");
    if (!entry) throw new Error("no SharePoint entry");
    const ui = fakeUi(fixture(entry).ui, calls);
    render(first, ui, "https://*.sharepoint.com/*");
    render(first, ui, "https://*.sharepoint.com/*");
    render(second, ui, "https://*.sharepoint.com/*");
    // The status is read once per instance (it is module state, asked for once per frame).
    expect(calls.filter((method) => method === "getStatus")).toHaveLength(2);
  });

  it("wraps every spec module in a factory", async () => {
    for (const name of new Set(CONFIGURATORS.map((entry) => entry.spec))) {
      const module = await import(/* @vite-ignore */ `configurator-spec:${name}`);
      expect(typeof module.createConfiguratorSpec, name).toBe("function");
    }
  });
});

describe("the rendered form", () => {
  it("ties each label to its control", async () => {
    const spec = await loadConfiguratorSpec("email/email");
    const html = render(spec, fakeUi(), "http://localhost/mailbox/:user");
    const forId = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(forId).toBeTruthy();
    expect(html).toContain(`id="${forId}"`);
    expect(html).toMatch(/<input[^>]*aria-describedby="[^"]+"/);
  });

  it("shows a loading state while it derives values from a resource URL", async () => {
    const spec = await loadConfiguratorSpec("slack/workspace");
    const html = renderToString(
      createElement(ConfiguratorForm, {
        spec,
        ui: fakeUi(),
        resourceUrlPattern: "https://*",
        initialResourceUrl: "https://app.slack.com/client/T123",
        ensureResources: async () => true,
      }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="combobox"');
  });

  it("shows a spec's render error in place of the form", () => {
    const spec: ConfiguratorUISpec<unknown> = {
      initial: {},
      resourceUrl: () => "https://example.com/",
      render() {
        throw new Error("Boom");
      },
    };
    const html = render(spec, fakeUi(), "https://*");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Boom");
  });
});
