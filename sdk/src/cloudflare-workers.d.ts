// Type declarations for cloudflare:workers module.
// At runtime in Workers, the real module is provided by the workerd runtime.
// This declaration exists only so the SDK compiles without @cloudflare/workers-types.
declare module "cloudflare:workers" {
  export function waitUntil(promise: Promise<unknown>): void;

  /** Native custom spans API (workerd 2026-06-16+). */
  export namespace tracing {
    function enterSpan<T, A extends unknown[]>(
      name: string,
      callback: (span: CloudflareSpan, ...args: A) => T,
      ...args: A
    ): T;
  }

  export class CloudflareSpan {
    readonly isTraced: boolean;
    setAttribute(
      key: string,
      value: string | number | boolean | undefined,
    ): void;
  }
}
