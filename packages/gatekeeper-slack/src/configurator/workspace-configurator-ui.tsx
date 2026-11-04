// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-slack/src/configurator/workspace-configurator-ui.tsx (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@crm/gatekeeper-configurator-ui";
import type {
  WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues,
} from "./workspace-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.teamId === "string" && /^T[A-Z0-9]+$/.test(values.teamId);
  },

  resourceUrl({ values }) {
    if (!values.teamId || !/^T[A-Z0-9]+$/.test(values.teamId)) throw new Error("Choose a Slack workspace.");
    return `https://app.slack.com/client/${values.teamId}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const teamId = new URL(resourceUrl).pathname.split("/").filter(Boolean)[1];
    return teamId && /^T[A-Z0-9]+$/.test(teamId) ? { teamId } : {};
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Workspace"
        description="This connection lets the client read the channels and direct messages you can access, browse Slack workspace members, and search messages."
      >
        <Autocomplete
          name="teamId"
          value={values.teamId}
          placeholder="Choose a Slack workspace..."
          loadOptions={query => ui.listWorkspaces(query)}
          onChange={teamId => setValues({ teamId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
