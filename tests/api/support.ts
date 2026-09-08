/**
 * Test support for the REST API suite. Filename has no `.test.` segment,
 * so the runner glob for compiled test files does not pick it up.
 *
 * `startServer(app)` boots an Express app on an ephemeral port; tests
 * hit it with the global `fetch`. This matches how the scaffold's app
 * smoke test worked — no `supertest` dependency, real Express routing
 * and error-forwarding exercised end to end.
 */

import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Boot `app` on port 0 and return its base URL + a `close()`. */
export function startServer(app: Express): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export interface JsonResponse {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
}

/** GET `url` and parse the body as JSON when possible. */
export async function getJson(url: string, init?: RequestInit): Promise<JsonResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}
