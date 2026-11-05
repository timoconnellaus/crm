// The resource-configurator spec for a webhook endpoint, written against the configurator authoring
// API. The admin names the endpoint, picks how its deliveries are signed, and saves: the secret is
// generated (or the provider-issued one kept) by the host-only `ui.configure()` and shown once.
import {
  Button,
  type ConfiguratorUISpec,
  Field,
  // biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig `jsxFactory: "h"`).
  h,
  Notice,
  RadioCards,
  Section,
  TextInput,
} from "@relationship-os/gatekeeper-configurator-ui";
import type {
  EndpointConfiguratorRpc,
  EndpointConfiguratorValues,
} from "./endpoint-configurator-types.js";

const SCHEME_OPTIONS = [
  {
    value: "hmac-sha256",
    title: "Generic HMAC-SHA256",
    description: "X-Webhook-Signature: sha256=<hex>, optionally with X-Webhook-Timestamp.",
  },
  { value: "github", title: "GitHub", description: "X-Hub-Signature-256: sha256=<hex>." },
  { value: "stripe", title: "Stripe", description: "Stripe-Signature: t=<ts>,v1=<hex>." },
  {
    value: "slack",
    title: "Slack",
    description: "X-Slack-Signature: v0=<hex> with X-Slack-Request-Timestamp.",
  },
];

const ENDPOINT_ID = /^[a-z0-9-]{3,64}$/;

export default {
  initial: { scheme: "hmac-sha256" },

  isReady({ values }) {
    return typeof values.endpointId === "string" && ENDPOINT_ID.test(values.endpointId);
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.endpointId);
  },

  render({ values, setValues, ui }) {
    const save = () => {
      ui.configure({
        endpointId: values.endpointId,
        scheme: values.scheme ?? "hmac-sha256",
        secret: values.secret || undefined,
      }).then(
        (configured) =>
          setValues({
            issuedSecret: configured.secret,
            deliveryUrl: configured.url,
            secret: null,
            error: null,
          }),
        (error: unknown) => setValues({ error: String(error) }),
      );
    };
    return (
      <Section>
        <Field
          label="Endpoint id"
          description="3 to 64 lower-case letters, digits or hyphens. It becomes part of the URL."
        >
          <TextInput
            name="endpointId"
            value={values.endpointId}
            placeholder="github-main"
            onChange={(endpointId) => setValues({ endpointId, issuedSecret: null })}
          />
        </Field>
        <Field label="Signature scheme">
          <RadioCards
            value={values.scheme}
            options={SCHEME_OPTIONS}
            onChange={(scheme) => setValues({ scheme })}
          />
        </Field>
        <Field
          label="Signing secret"
          description="Paste the provider's secret (Stripe, Slack), or leave empty to generate one."
          optional
        >
          <TextInput
            name="secret"
            value={values.secret}
            placeholder="Generate one"
            optional
            onChange={(secret) => setValues({ secret })}
          />
        </Field>
        <Button onClick={save} disabled={!ENDPOINT_ID.test(values.endpointId ?? "")}>
          Save endpoint
        </Button>
        {values.issuedSecret ? (
          <Notice>
            Copy this secret into the provider now; it is not shown again: {values.issuedSecret}.
            Deliveries go to {values.deliveryUrl}.
          </Notice>
        ) : null}
        {values.error ? <Notice tone="error">{values.error}</Notice> : null}
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<EndpointConfiguratorRpc, EndpointConfiguratorValues>;
