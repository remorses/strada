// Org-wide token CLI commands. The only supported scope today is `ingest`,
// which authenticates server-side SDK writes to the collector.

import { goke } from "goke";
import dedent from "string-dedent";
import { z } from "zod";
import { bold, cyan, dim } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { resolveCurrentOrg } from "./orgs.ts";
import { printTable, timeAgo } from "./table.ts";

export const tokensCli = goke();

tokensCli
  .command(
    "tokens create <name>",
    dedent`
      Create an org-wide token with an explicit scope.

      Tokens with the ingest scope authenticate writes to the OTLP collector only. They do
      not grant query access, project management access, or access to the
      Strada website API. Use them in Node.js, Cloudflare Workers, Vercel, and
      other trusted server runtimes.

      The only supported scope today is \`ingest\`. The scope is still required
      as \`--scope\` so command usage will stay stable when more token scopes are
      added later.

      Browser SDKs should not use tokens. Browser ingest stays
      anonymous and is protected by the collector's anonymous rate limit.
    `,
  )
  .option("--scope <scope>", z.enum(["ingest"]).describe("Token scope. Currently only ingest is supported"))
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .action(async (name, options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const org = await resolveCurrentOrg({ org: options.org || undefined });

    const res = await safeFetch("/api/v0/orgs/:orgId/tokens", {
      method: "POST",
      params: { orgId: org.id },
      body: { name, scope: options.scope },
    });
    if (res instanceof Error) throw res;

    output.log(bold("Token created!"));
    output.log("");
    output.log(`  Name:   ${res.name}`);
    output.log(`  Scope:  ${res.scope}`);
    output.log(`  Token:  ${cyan(res.key)}`);
    output.log("");
    output.log(dim("Save this now. The full token is only shown once."));
    output.log(dim("Use it only in server-side SDKs:"));
    output.log(dim("  initStrada({ token: process.env.STRADA_TOKEN })"));
  });

tokensCli
  .command(
    "tokens list",
    dedent`
      List org-wide tokens.

      This shows token metadata and prefixes only. Full token values are never
      stored by Strada and cannot be recovered after creation. Create a new
      token and delete the old one when rotating credentials.
    `,
  )
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .action(async (options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const org = await resolveCurrentOrg({ org: options.org || undefined });

    const res = await safeFetch("/api/v0/orgs/:orgId/tokens", {
      params: { orgId: org.id },
    });
    if (res instanceof Error) throw res;

    if (res.tokens.length === 0) {
      output.log("No tokens yet. Create one with `strada tokens create <name> --scope ingest`");
      return;
    }

    output.log(bold(`Tokens in ${org.name}:`));
    output.log("");
    printTable(output, {
      columns: [
        { key: "id", label: "ID", color: dim, maxWidth: 12 },
        { key: "name", label: "NAME", color: cyan, maxWidth: 28 },
        { key: "prefix", label: "PREFIX" },
        { key: "createdBy", label: "CREATED BY" },
        { key: "created", label: "CREATED" },
      ],
      rows: res.tokens.map((token) => ({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        createdBy: token.createdBy,
        created: timeAgo(new Date(token.createdAt).toISOString()),
      })),
    });
  });

tokensCli
  .command(
    "tokens delete <id>",
    dedent`
      Delete an org-wide token.

      Use this to rotate leaked or obsolete server-side ingestion credentials.
      Deleting a token immediately stops future collector requests that use it.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const res = await safeFetch("/api/v0/org-tokens/:id", {
      method: "DELETE",
      params: { id },
    });
    if (res instanceof Error) throw res;
    output.log(`Deleted token ${id}.`);
  });
