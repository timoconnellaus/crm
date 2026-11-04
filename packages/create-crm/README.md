# create-crm

Install the open-source CRM (github.com/timoconnellaus/crm) into your own Cloudflare account, then
upgrade and roll it back. It downloads a release from GitHub Releases, verifies its sha256 and its
GitHub build attestation, and talks to the Cloudflare API with your token. No wrangler, no service
of ours, no telemetry.

```sh
npx create-crm                  # install (or repair an install)
npx create-crm upgrade          # update to the newest release on your channel
npx create-crm rollback         # undo the last update (redeploy + restore the database bookmark)
npx create-crm status
npx create-crm --help           # every option, and the API token permissions
```

The token needs, on the account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV
Storage Edit, Queues Edit, Vectorize Edit and Account Settings Read; for a custom hostname also Zone
Read and Workers Routes Edit on its zone. The CLI never prints secret values.

Full guide: [docs/deploying.md](https://github.com/timoconnellaus/crm/blob/main/docs/deploying.md).
