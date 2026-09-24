import { FormEvent, useCallback, useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api";

type Iteration = {
  id: number;
  last_commit_id: string;
  status: string;
  ai_summary: string | null;
  raw_ai_response: string | null;
  tokens_used: number;
  estimated_cost_usd: number;
  error_message: string | null;
  error_type: string | null;
  created_at: string;
  reviewed_at: string | null;
};

type PullRequest = {
  pr_id: number;
  title: string;
  author_name: string;
  repository_name: string;
  pr_url: string;
  pr_status: string;
  updated_at: string;
  latest_iteration: Iteration | null;
};

type PullRequestDetail = Omit<PullRequest, "latest_iteration"> & {
  created_at: string;
  iterations: Iteration[];
};

type Metrics = {
  total_prs_reviewed: number;
  tokens_used: number;
  estimated_cost_usd: number;
  daily_cost_usd: number;
};

type Finding = {
  file: string;
  line: number;
  severity: "critical" | "suggestion" | "nit";
  comment: string;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function Status({ value }: { value: string }) {
  const colors: Record<string, string> = {
    REVIEWED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    FAILED: "bg-red-50 text-red-700 border-red-200",
    SKIPPED: "bg-amber-50 text-amber-800 border-amber-200",
    ATTEMPTING: "bg-blue-50 text-blue-700 border-blue-200",
    PENDING: "bg-slate-100 text-slate-700 border-slate-200",
  };
  return (
    <span
      className={`inline-flex border px-2 py-0.5 text-xs font-medium ${colors[value] ?? colors.PENDING}`}
    >
      {value}
    </span>
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        className="w-full max-w-sm border border-slate-200 bg-white p-8 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) onLogin(token.trim());
        }}
      >
        <h1 className="text-2xl font-semibold">PR Reviewer</h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter the dashboard bearer token configured on the backend.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="token">
          Dashboard token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          className="mt-2 w-full border border-slate-300 px-3 py-2"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="mt-4 w-full bg-accent px-4 py-2 font-medium text-white hover:bg-teal-800">
          Sign in
        </button>
      </form>
    </main>
  );
}

function ReviewDetail({
  detail,
  onClose,
  onRereview,
  queueing,
}: {
  detail: PullRequestDetail;
  onClose: () => void;
  onRereview: () => void;
  queueing: boolean;
}) {
  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-slate-950/30">
      <button
        className="flex-1 cursor-default"
        aria-label="Close details"
        onClick={onClose}
      />
      <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">
              {detail.repository_name} · PR {detail.pr_id}
            </p>
            <h2 className="mt-1 text-xl font-semibold">{detail.title}</h2>
          </div>
          <button
            className="border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a
            className="text-sm font-medium text-accent underline"
            href={detail.pr_url}
            target="_blank"
            rel="noreferrer"
          >
            Open in Azure DevOps
          </a>
          <button
            className="bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            disabled={queueing}
            onClick={onRereview}
          >
            {queueing ? "Queueing…" : "Re-review current commit"}
          </button>
        </div>

        <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Review history
        </h3>
        <div className="mt-3 space-y-4">
          {detail.iterations.map((iteration) => {
            let findings: Finding[] = [];
            try {
              findings = iteration.raw_ai_response
                ? (JSON.parse(iteration.raw_ai_response).findings ?? [])
                : [];
            } catch {
              findings = [];
            }
            return (
              <section key={iteration.id} className="border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Status value={iteration.status} />
                  <time className="text-xs text-slate-500">
                    {formatDate(iteration.reviewed_at ?? iteration.created_at)}
                  </time>
                </div>
                <p className="mt-3 font-mono text-xs text-slate-500">
                  {iteration.last_commit_id.slice(0, 12)}
                </p>
                {iteration.ai_summary && (
                  <p className="mt-2 text-sm">{iteration.ai_summary}</p>
                )}
                {iteration.error_message && (
                  <p className="mt-2 border-l-2 border-red-400 pl-3 text-sm text-red-700">
                    {iteration.error_message}
                  </p>
                )}
                {findings.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {findings.map((finding, index) => (
                      <div
                        key={`${finding.file}-${finding.line}-${index}`}
                        className="bg-slate-50 p-3 text-sm"
                      >
                        <div className="flex flex-wrap gap-2 font-mono text-xs">
                          <span className="font-semibold uppercase text-accent">
                            {finding.severity}
                          </span>
                          <span>
                            {finding.file}:{finding.line}
                          </span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap">
                          {finding.comment}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  {iteration.tokens_used.toLocaleString()} tokens · $
                  {iteration.estimated_cost_usd.toFixed(4)}
                </p>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("token") ?? "");
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState("");

  const request = useCallback(
    async <T,>(path: string, options?: RequestInit): Promise<T> => {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
      if (response.status === 401) {
        sessionStorage.removeItem("token");
        setToken("");
        throw new Error("The dashboard token was rejected.");
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail ?? `Request failed with ${response.status}`);
      }
      return response.json() as Promise<T>;
    },
    [token],
  );

  const loadDashboard = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [list, currentMetrics] = await Promise.all([
        request<{ items: PullRequest[] }>(
          `/prs?search=${encodeURIComponent(activeSearch)}`,
        ),
        request<Metrics>("/metrics"),
      ]);
      setPrs(list.items);
      setMetrics(currentMetrics);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load");
    } finally {
      setLoading(false);
    }
  }, [activeSearch, request, token]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const openDetail = async (prId: number) => {
    setError("");
    try {
      setDetail(await request<PullRequestDetail>(`/prs/${prId}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load");
    }
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setActiveSearch(search.trim());
  };

  if (!token) {
    return (
      <Login
        onLogin={(nextToken) => {
          sessionStorage.setItem("token", nextToken);
          setToken(nextToken);
        }}
      />
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-300 pb-5">
        <div>
          <p className="text-sm font-medium text-accent">Azure DevOps</p>
          <h1 className="text-2xl font-semibold">AI PR Reviewer</h1>
        </div>
        <button
          className="text-sm text-slate-600 underline"
          onClick={() => {
            sessionStorage.removeItem("token");
            setToken("");
          }}
        >
          Sign out
        </button>
      </header>

      <section className="grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-4">
        {[
          ["PRs reviewed", metrics?.total_prs_reviewed.toLocaleString() ?? "—"],
          ["Tokens used", metrics?.tokens_used.toLocaleString() ?? "—"],
          ["Total cost", `$${metrics?.estimated_cost_usd.toFixed(4) ?? "—"}`],
          ["Cost today", `$${metrics?.daily_cost_usd.toFixed(4) ?? "—"}`],
        ].map(([label, value]) => (
          <div key={label} className="bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {label}
            </p>
            <p className="mt-1 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </section>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Pull requests</h2>
        <form className="flex" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="search">
            Search pull requests
          </label>
          <input
            id="search"
            className="w-64 border border-slate-300 bg-white px-3 py-2 text-sm"
            placeholder="Search title, author, repository"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button className="bg-ink px-4 py-2 text-sm font-medium text-white">
            Search
          </button>
        </form>
      </div>

      {error && (
        <p className="mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-4 overflow-x-auto border border-slate-200 bg-white">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Pull request</th>
              <th className="px-4 py-3 font-medium">Repository</th>
              <th className="px-4 py-3 font-medium">Author</th>
              <th className="px-4 py-3 font-medium">Review</th>
              <th className="px-4 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {prs.map((pr) => (
              <tr
                key={pr.pr_id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => void openDetail(pr.pr_id)}
              >
                <td className="px-4 py-3">
                  <p className="font-medium">{pr.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">PR {pr.pr_id}</p>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {pr.repository_name}
                </td>
                <td className="px-4 py-3 text-slate-600">{pr.author_name}</td>
                <td className="px-4 py-3">
                  {pr.latest_iteration ? (
                    <Status value={pr.latest_iteration.status} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {formatDate(pr.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && prs.length === 0 && (
          <p className="p-8 text-center text-sm text-slate-500">
            No pull requests found.
          </p>
        )}
        {loading && (
          <p className="p-8 text-center text-sm text-slate-500">Loading…</p>
        )}
      </div>

      {detail && (
        <ReviewDetail
          detail={detail}
          queueing={queueing}
          onClose={() => setDetail(null)}
          onRereview={async () => {
            setQueueing(true);
            try {
              await request(`/prs/${detail.pr_id}/re-review`, { method: "POST" });
              setError("");
            } catch (queueError) {
              setError(
                queueError instanceof Error ? queueError.message : "Unable to queue",
              );
            } finally {
              setQueueing(false);
            }
          }}
        />
      )}
    </main>
  );
}
