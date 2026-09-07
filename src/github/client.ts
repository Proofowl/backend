/**
 * GitHub API access for verification. Read-only; uses the public REST
 * API plus one GraphQL query for the closing-issue link (which REST
 * does not expose directly).
 *
 * `GitHubClient` is an interface so tests inject recorded fixtures
 * instead of hitting the network (see tests/github/). `HttpGitHubClient`
 * is the real implementation; a token is optional and only raises the
 * rate limit.
 */

import { NotFoundError, UpstreamError } from "../lib/errors.js";
import type { GitHubIssue, GitHubLabeledEvent, GitHubPullRequest } from "./types.js";

export interface GitHubClient {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue>;
  /** All `labeled` events on an issue, oldest first, paginated fully. */
  getIssueLabeledEvents(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubLabeledEvent[]>;
  /**
   * Issue numbers this PR will close via GitHub's own closing-issue
   * mechanism (closing keyword in the body, or a manually linked issue).
   * Uses the GraphQL `closingIssuesReferences` connection.
   */
  getClosingIssueNumbers(owner: string, repo: string, prNumber: number): Promise<number[]>;
}

export interface HttpGitHubClientOptions {
  apiBaseUrl: string;
  token?: string | undefined;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** GraphQL endpoint. Defaults to `${apiBaseUrl}/graphql`. */
  graphqlUrl?: string;
}

const USER_AGENT = "proofowl-backend (verification)";

export class HttpGitHubClient implements GitHubClient {
  private readonly base: string;
  private readonly graphqlUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpGitHubClientOptions) {
    this.base = opts.apiBaseUrl.replace(/\/+$/, "");
    this.graphqlUrl = opts.graphqlUrl ?? `${this.base}/graphql`;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
      ...extra,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async getJson<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { headers: this.headers() });
    } catch (err) {
      throw new UpstreamError(`GitHub request failed: GET ${path}`, err);
    }
    if (res.status === 404) throw new NotFoundError(`GitHub 404: GET ${path}`);
    if (!res.ok) {
      throw new UpstreamError(`GitHub ${res.status} for GET ${path}: ${await safeText(res)}`);
    }
    return (await res.json()) as T;
  }

  /** Follow RFC 5988 `Link: rel="next"` pagination to completion. */
  private async getJsonPaged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.base}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: this.headers() });
      } catch (err) {
        throw new UpstreamError(`GitHub request failed: GET ${url}`, err);
      }
      if (res.status === 404) throw new NotFoundError(`GitHub 404: GET ${url}`);
      if (!res.ok) {
        throw new UpstreamError(`GitHub ${res.status} for GET ${url}: ${await safeText(res)}`);
      }
      const page = (await res.json()) as T[];
      out.push(...page);
      url = nextLink(res.headers.get("link"));
    }
    return out;
  }

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest> {
    return this.getJson<GitHubPullRequest>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}`);
  }

  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    return this.getJson<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}`);
  }

  async getIssueLabeledEvents(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubLabeledEvent[]> {
    const events = await this.getJsonPaged<GitHubLabeledEvent>(
      `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/timeline`,
    );
    return events.filter((e) => e.event === "labeled");
  }

  async getClosingIssueNumbers(owner: string, repo: string, prNumber: number): Promise<number[]> {
    const query = `
      query ($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            closingIssuesReferences(first: 50) { nodes { number } }
          }
        }
      }`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.graphqlUrl, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ query, variables: { owner, repo, pr: prNumber } }),
      });
    } catch (err) {
      throw new UpstreamError("GitHub GraphQL request failed", err);
    }
    if (!res.ok) {
      throw new UpstreamError(`GitHub GraphQL ${res.status}: ${await safeText(res)}`);
    }
    const body = (await res.json()) as {
      errors?: unknown[];
      data?: {
        repository?: {
          pullRequest?: { closingIssuesReferences?: { nodes?: Array<{ number: number }> } };
        };
      };
    };
    if (body.errors?.length) {
      throw new UpstreamError(`GitHub GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    const nodes = body.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    return nodes.map((n) => n.number);
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
