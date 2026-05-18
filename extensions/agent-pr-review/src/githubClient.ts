/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const API = 'https://api.github.com';
const USER_AGENT = 'vscode-agent-pr-review/0.1';

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
}

export interface PullRequestSummary {
	readonly number: number;
	readonly title: string;
	readonly state: 'open' | 'closed';
	readonly draft: boolean;
	readonly htmlUrl: string;
	readonly authorLogin: string;
	readonly headRef: string;
	readonly baseRef: string;
	readonly updatedAt: string;
	readonly mergeable?: boolean | null;
}

export interface PullRequestDetail extends PullRequestSummary {
	readonly body: string;
	readonly baseSha: string;
	readonly headSha: string;
	readonly changedFiles: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface ReviewComment {
	readonly path: string;
	readonly line: number;
	readonly side?: 'LEFT' | 'RIGHT';
	readonly body: string;
}

export class GitHubClient {

	constructor(private readonly token: string) { }

	async listPullRequests(ref: RepoRef, state: 'open' | 'closed' | 'all' = 'open'): Promise<PullRequestSummary[]> {
		const data = await this.request<unknown[]>(`/repos/${ref.owner}/${ref.repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`);
		return data.map(item => toPullRequestSummary(item));
	}

	async getPullRequest(ref: RepoRef, number: number): Promise<PullRequestDetail> {
		const data = await this.request<Record<string, unknown>>(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`);
		return toPullRequestDetail(data);
	}

	async getPullRequestDiff(ref: RepoRef, number: number): Promise<string> {
		const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/pulls/${number}`, {
			headers: {
				'Authorization': `token ${this.token}`,
				'Accept': 'application/vnd.github.v3.diff',
				'User-Agent': USER_AGENT,
			},
		});
		if (!res.ok) {
			throw new Error(`GitHub ${res.status}: ${await res.text()}`);
		}
		return await res.text();
	}

	async createPendingReview(ref: RepoRef, number: number, comments: readonly ReviewComment[], summary?: string): Promise<{ id: number; htmlUrl: string }> {
		const body = {
			event: undefined,
			body: summary,
			comments: comments.map(c => ({
				path: c.path,
				line: c.line,
				side: c.side ?? 'RIGHT',
				body: c.body,
			})),
		};
		const data = await this.request<Record<string, unknown>>(
			`/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews`,
			{ method: 'POST', body: JSON.stringify(body) },
		);
		return {
			id: typeof data.id === 'number' ? data.id : 0,
			htmlUrl: typeof data.html_url === 'string' ? data.html_url : '',
		};
	}

	private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
		const res = await fetch(`${API}${pathname}`, {
			...init,
			headers: {
				'Authorization': `token ${this.token}`,
				'Accept': 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': USER_AGENT,
				...(init.body ? { 'Content-Type': 'application/json' } : {}),
				...(init.headers as Record<string, string> | undefined),
			},
		});
		if (!res.ok) {
			throw new Error(`GitHub ${res.status} on ${pathname}: ${await res.text()}`);
		}
		return await res.json() as T;
	}
}

function toPullRequestSummary(raw: unknown): PullRequestSummary {
	const r = raw as Record<string, unknown>;
	const user = r.user as Record<string, unknown> | undefined;
	const head = r.head as Record<string, unknown> | undefined;
	const base = r.base as Record<string, unknown> | undefined;
	return {
		number: r.number as number,
		title: (r.title as string | undefined) ?? '',
		state: r.state === 'closed' ? 'closed' : 'open',
		draft: Boolean(r.draft),
		htmlUrl: (r.html_url as string | undefined) ?? '',
		authorLogin: (user?.login as string | undefined) ?? '',
		headRef: (head?.ref as string | undefined) ?? '',
		baseRef: (base?.ref as string | undefined) ?? '',
		updatedAt: (r.updated_at as string | undefined) ?? '',
		mergeable: r.mergeable as boolean | null | undefined,
	};
}

function toPullRequestDetail(raw: Record<string, unknown>): PullRequestDetail {
	const summary = toPullRequestSummary(raw);
	const head = raw.head as Record<string, unknown> | undefined;
	const base = raw.base as Record<string, unknown> | undefined;
	return {
		...summary,
		body: (raw.body as string | undefined) ?? '',
		baseSha: (base?.sha as string | undefined) ?? '',
		headSha: (head?.sha as string | undefined) ?? '',
		changedFiles: (raw.changed_files as number | undefined) ?? 0,
		additions: (raw.additions as number | undefined) ?? 0,
		deletions: (raw.deletions as number | undefined) ?? 0,
	};
}
