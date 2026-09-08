import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpGitHubClient } from "../../src/github/client.js";
import {
  HttpApprovedOrgsSource,
  parseOrgsFromJson,
  orgIsApproved,
} from "../../src/github/approvedOrgs.js";

/** Minimal Response-like object for a fake fetch. */
function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  const headers = new Headers();
  if (init.link) headers.set("link", init.link);
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

test("HttpGitHubClient.getPullRequest hits the expected REST path", async () => {
  const calls: string[] = [];
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse({ number: 42, merged: true });
    }) as typeof fetch,
  });
  const pr = await client.getPullRequest("stellar", "soroban-examples", 42);
  assert.equal(pr.number, 42);
  assert.deepEqual(calls, ["https://api.github.com/repos/stellar/soroban-examples/pulls/42"]);
});

test("HttpGitHubClient.getIssueLabeledEvents follows Link pagination and filters to 'labeled'", async () => {
  const pages: Record<string, Response> = {
    "https://api.github.com/repos/o/r/issues/7/timeline?per_page=100": jsonResponse(
      [
        { event: "labeled", created_at: "2026-01-01T00:00:00Z", label: { name: "Wave" } },
        { event: "commented", created_at: "2026-01-02T00:00:00Z" },
      ],
      {
        link: '<https://api.github.com/repos/o/r/issues/7/timeline?per_page=100&page=2>; rel="next"',
      },
    ),
    "https://api.github.com/repos/o/r/issues/7/timeline?per_page=100&page=2": jsonResponse([
      { event: "labeled", created_at: "2026-01-03T00:00:00Z", label: { name: "bug" } },
    ]),
  };
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (url: string | URL) => {
      const r = pages[String(url)];
      if (!r) throw new Error(`unexpected url ${url}`);
      return r;
    }) as typeof fetch,
  });
  const events = await client.getIssueLabeledEvents("o", "r", 7);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.label?.name),
    ["Wave", "bug"],
  );
});

test("HttpGitHubClient.getClosingIssueNumbers parses the GraphQL connection", async () => {
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      assert.equal(init?.method, "POST");
      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.variables.pr, 42);
      return jsonResponse({
        data: {
          repository: {
            pullRequest: { closingIssuesReferences: { nodes: [{ number: 7 }, { number: 9 }] } },
          },
        },
      });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.getClosingIssueNumbers("o", "r", 42), [7, 9]);
});

test("HttpGitHubClient.listRepoIssues: closed state by default, filters out PRs", async () => {
  const calls: string[] = [];
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse([
        { number: 7, state: "closed", labels: [{ name: "Wave" }] },
        { number: 8, state: "closed", labels: [], pull_request: { url: "…" } },
        { number: 9, state: "closed", labels: [{ name: "bug" }] },
      ]);
    }) as typeof fetch,
  });
  const issues = await client.listRepoIssues("o", "r");
  assert.deepEqual(
    issues.map((i) => i.number),
    [7, 9],
  );
  assert.match(calls[0]!, /\/repos\/o\/r\/issues\?/);
  assert.match(calls[0]!, /state=closed/);
});

test("HttpGitHubClient.listRepoIssues: maxIssues caps the fetch and stops paging", async () => {
  const pageFor = (page: number): Response => {
    const rows = Array.from({ length: 100 }, (_v, i) => ({
      number: page * 100 + i,
      state: "closed",
      labels: [],
    }));
    return jsonResponse(rows, {
      link: `<https://api.github.com/repos/o/r/issues?state=closed&page=${page + 1}>; rel="next"`,
    });
  };
  let hits = 0;
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async () => {
      const r = pageFor(hits);
      hits++;
      return r;
    }) as typeof fetch,
  });
  const issues = await client.listRepoIssues("o", "r", { maxIssues: 150 });
  assert.equal(issues.length, 150);
  assert.equal(hits, 2, "stopped after the second page crossed the cap");
});

test("HttpGitHubClient.listRepoIssues: labels prefilter and explicit state pass through", async () => {
  const calls: string[] = [];
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse([]);
    }) as typeof fetch,
  });
  await client.listRepoIssues("o", "r", { state: "all", labels: ["Wave", "stellar wave"] });
  assert.match(calls[0]!, /state=all/);
  assert.match(calls[0]!, /labels=Wave%2Cstellar\+wave/);
});

test("HttpGitHubClient.getIssueLinkedPullRequests parses the GraphQL connection", async () => {
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      assert.equal(init?.method, "POST");
      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.variables.issue, 7);
      assert.match(parsed.query, /closedByPullRequestsReferences/);
      return jsonResponse({
        data: {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                nodes: [
                  { number: 42, merged: true },
                  { number: 43, merged: false },
                ],
              },
            },
          },
        },
      });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.getIssueLinkedPullRequests("o", "r", 7), [
    { number: 42, merged: true },
    { number: 43, merged: false },
  ]);
});

test("HttpGitHubClient.getIssueLinkedPullRequests: no linked PRs -> empty array", async () => {
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async () =>
      jsonResponse({
        data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } },
      })) as typeof fetch,
  });
  assert.deepEqual(await client.getIssueLinkedPullRequests("o", "r", 7), []);
});

test("HttpGitHubClient GraphQL: an errors[] payload becomes UpstreamError", async () => {
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async () =>
      jsonResponse({ errors: [{ message: "Could not resolve to a Repository" }] })) as typeof fetch,
  });
  await assert.rejects(client.getIssueLinkedPullRequests("o", "r", 7), /GraphQL errors/);
});

test("HttpGitHubClient surfaces a GitHub 404 as NotFoundError", async () => {
  const client = new HttpGitHubClient({
    apiBaseUrl: "https://api.github.com",
    fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
  });
  await assert.rejects(client.getPullRequest("o", "r", 1), /404/);
});

// --- approved-orgs source ---------------------------------------------

test("parseOrgsFromJson recognises a plain array, {orgs:[...]}, and objects with login", () => {
  assert.deepEqual(parseOrgsFromJson(["stellar", "aquarius-fi"]).sort(), [
    "aquarius-fi",
    "stellar",
  ]);
  assert.deepEqual(parseOrgsFromJson({ orgs: ["Stellar"] }), ["Stellar"]);
  assert.deepEqual(
    parseOrgsFromJson({
      data: { approved: [{ login: "stellar" }, { login: "soroban-dev" }] },
    }).sort(),
    ["soroban-dev", "stellar"],
  );
});

test("HttpApprovedOrgsSource: JSON endpoint -> status ok, case-insensitive membership", async () => {
  const src = new HttpApprovedOrgsSource({
    url: "https://example.test/orgs.json",
    cacheTtlMs: 0,
    fetchImpl: (async () =>
      new Response(JSON.stringify(["Stellar", "aquarius-fi"]))) as typeof fetch,
  });
  const snap = await src.listApprovedOrgs();
  assert.equal(snap.status, "ok");
  assert.equal(orgIsApproved(snap, "stellar"), true);
  assert.equal(orgIsApproved(snap, "STELLAR"), true);
  assert.equal(orgIsApproved(snap, "nope"), false);
});

test("HttpApprovedOrgsSource: client-rendered HTML with no org data -> indeterminate", async () => {
  // Shape of the real drips.network/wave/stellar/orgs response: a
  // SvelteKit shell, no embedded org list.
  const html =
    "<!doctype html><html><head><script>/* theme */</script></head>" +
    '<body><div id="svelte"></div><script>__sveltekit_x = {}</script></body></html>';
  const src = new HttpApprovedOrgsSource({
    url: "https://drips.network/wave/stellar/orgs",
    cacheTtlMs: 0,
    fetchImpl: (async () =>
      new Response(html, { headers: { "content-type": "text/html" } })) as typeof fetch,
  });
  const snap = await src.listApprovedOrgs();
  assert.equal(snap.status, "indeterminate");
  if (snap.status === "indeterminate")
    assert.match(snap.reason, /client-rendered|no embedded org data/);
});

test("HttpApprovedOrgsSource: non-200 -> indeterminate, not a throw", async () => {
  const src = new HttpApprovedOrgsSource({
    url: "https://example.test/orgs.json",
    cacheTtlMs: 0,
    fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch,
  });
  const snap = await src.listApprovedOrgs();
  assert.equal(snap.status, "indeterminate");
});

test("HttpApprovedOrgsSource caches within the TTL window", async () => {
  let hits = 0;
  const src = new HttpApprovedOrgsSource({
    url: "https://example.test/orgs.json",
    cacheTtlMs: 10_000,
    fetchImpl: (async () => {
      hits++;
      return new Response(JSON.stringify(["stellar"]));
    }) as typeof fetch,
  });
  await src.listApprovedOrgs();
  await src.listApprovedOrgs();
  assert.equal(hits, 1);
});
