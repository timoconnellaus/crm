// Resource configurator for a sender address, written against the gatekeeper configurator
// authoring API. The CRM app renders it with its own components (see docs/stages/06-integrations.md,
// "Resource pickers"); `ui` is the SenderConfiguratorRpc from startResourceConfigurator.
import {
  type ConfiguratorUISpec,
  Field,
  // biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig `jsxFactory: "h"`).
  h,
  Section,
  TextInput,
} from "@crm/gatekeeper-configurator-ui";
import { isEmailAddress } from "../address";
import { senderFromUrl, senderUrl } from "../sender";
import type { SenderConfiguratorRpc, SenderConfiguratorValues } from "./sender-configurator-types";

function cleanAddress(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export default {
  initial: { address: "" },

  isReady({ values }) {
    return isEmailAddress(cleanAddress(values.address));
  },

  async resourceUrl({ values, ui }) {
    const address = cleanAddress(values.address);
    if (!isEmailAddress(address)) throw new Error("Enter a sender address, like crm@example.com.");
    const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    const allowed = await ui.allowedDomains();
    if (!allowed.includes(domain)) {
      throw new Error(
        allowed.length === 0
          ? "No sender domains are configured yet. Ask an administrator to set them up."
          : `Use an address at ${allowed.join(" or ")}.`,
      );
    }
    return senderUrl(address);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    try {
      return { address: senderFromUrl(resourceUrl) };
    } catch {
      return {};
    }
  },

  render({ values, setValues }) {
    return (
      <Section>
        <Field
          label="Sender address"
          description="Email goes out from this address. Its domain must be one your administrator has set up for sending."
        >
          <TextInput
            name="address"
            value={values.address}
            placeholder="crm@example.com"
            onChange={(address) => setValues({ address })}
          />
        </Field>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<SenderConfiguratorRpc, SenderConfiguratorValues>;
