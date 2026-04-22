import { describe, it, expect } from "vitest";
import { getProjectId } from "./get-project-id.ts";

describe("getProjectId", () => {
  it("normalizes ULID project ids to uppercase", () => {
    const req = new Request("https://01kpvgtt9cjw4znef414vhgrfd-ingest.strada.sh/v1/traces");
    expect(getProjectId(req)).toBe("01KPVGTT9CJW4ZNEF414VHGRFD");
  });

  it("keeps mixed project prefixes uppercased for hostname-insensitive matching", () => {
    const req = new Request("https://my-company-ingest.strada.sh/v1/logs");
    expect(getProjectId(req)).toBe("MY-COMPANY");
  });

  it("returns empty string for plain ingest subdomain (self-hosted)", () => {
    const req = new Request("https://ingest.mycompany.com/v1/traces");
    expect(getProjectId(req)).toBe("");
  });

  it("returns empty string for ingest.strada.sh", () => {
    const req = new Request("https://ingest.strada.sh/v1/logs");
    expect(getProjectId(req)).toBe("");
  });

  it("returns empty string for localhost", () => {
    const req = new Request("http://localhost:8080/v1/traces");
    expect(getProjectId(req)).toBe("");
  });

  it("returns empty string for plain domain", () => {
    const req = new Request("https://strada.sh/v1/traces");
    expect(getProjectId(req)).toBe("");
  });

  it("returns empty string for IP address", () => {
    const req = new Request("http://127.0.0.1:3000/v1/traces");
    expect(getProjectId(req)).toBe("");
  });
});
