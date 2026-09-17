import { getApiClient } from "./api-client.ts";

export async function waitForTinybirdMigration(ctx: {
  orgId: string;
  spinner: { message: (text: string) => void };
}): Promise<
  | Error
  | {
      ok: boolean;
      result: string;
      backend: string;
      tinybirdEndpoint: string;
    }
> {
  const { safeFetch } = getApiClient();
  const overallDeadline = Date.now() + 45 * 60 * 1000;
  const startedAt = Date.now();
  const migrateOnce = () =>
    safeFetch("/api/v0/orgs/:orgId/database/migrate", {
      method: "POST",
      params: { orgId: ctx.orgId },
    });
  while (true) {
    const result = await migrateOnce();
    if (result instanceof Error) return result;
    if (result.result !== "in_progress") return result;
    if (Date.now() >= overallDeadline) {
      return new Error(
        "The Tinybird data migration is still running after 45 minutes.\n" +
          "  It keeps running on Tinybird's side. Re-run `strada database upgrade` later to finish the promotion.",
      );
    }
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
    ctx.spinner.message(`Waiting for Tinybird data migration... (${elapsedMin}m elapsed)`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
