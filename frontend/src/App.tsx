import { FormEvent, Fragment, useCallback, useEffect, useState } from "react";

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
  azure_created_at: string | null;
  fetched_at: string | null;
  reviewed_at: string | null;
  latest_iteration: Iteration | null;
};

type PullRequestDetail = Omit<PullRequest, "latest_iteration"> & {
  iterations: Iteration[];
};

type Metrics = {
  total_prs_reviewed: number;
  tokens_used: number;
  estimated_cost_usd: number;
  daily_cost_usd: number;
  auto_pr_review_enabled: boolean;
  active_model_name: string | null;
  active_model_id: string | null;
};

type LlmModelItem = {
  id: number;
  name: string;
  base_url: string;
  api_key_masked: string;
  model: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
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
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatMonthLabel(value: string | null) {
  if (!value) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function monthSortKey(value: string | null) {
  if (!value) return "0000-00";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "0000-00";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function groupPrsByMonth(prs: PullRequest[]) {
  const groups = new Map<string, { label: string; items: PullRequest[] }>();
  for (const pr of prs) {
    const key = monthSortKey(pr.azure_created_at);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(pr);
    } else {
      groups.set(key, {
        label: formatMonthLabel(pr.azure_created_at),
        items: [pr],
      });
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, group]) => group);
}

function Status({ value }: { value: string }) {
  const colors: Record<string, string> = {
    REVIEWED: "bg-emerald-100 text-emerald-800 ring-emerald-700/15",
    FAILED: "bg-red-100 text-red-800 ring-red-700/15",
    SKIPPED: "bg-amber-100 text-amber-900 ring-amber-700/15",
    ATTEMPTING: "bg-sky-100 text-sky-800 ring-sky-700/15",
    PENDING: "bg-slate-100 text-slate-700 ring-slate-600/15",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide ring-1 ring-inset ${colors[value] ?? colors.PENDING}`}
    >
      {value}
    </span>
  );
}

function rowAccent(status: string | undefined) {
  switch (status) {
    case "REVIEWED":
      return "border-l-emerald-500";
    case "FAILED":
      return "border-l-red-500";
    case "SKIPPED":
      return "border-l-amber-500";
    case "ATTEMPTING":
      return "border-l-sky-500";
    case "PENDING":
      return "border-l-slate-300";
    default:
      return "border-l-transparent";
  }
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <form
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl shadow-black/30"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) onLogin(token.trim());
        }}
      >
        <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white">
          PR
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Enter the dashboard bearer token configured on the backend.
        </p>
        <label className="mt-6 block text-sm font-medium text-slate-700" htmlFor="token">
          Dashboard token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm shadow-sm transition focus:border-accent"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="mt-4 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800">
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
    <div className="fixed inset-0 z-10 flex justify-end bg-slate-950/50 backdrop-blur-[2px]">
      <button
        className="flex-1 cursor-default"
        aria-label="Close details"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-2xl min-w-0 flex-col overflow-hidden bg-slate-50 shadow-2xl">
        <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-6 sm:px-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">
              {detail.repository_name} · PR {detail.pr_id}
            </p>
            <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-slate-950">
              {detail.title}
            </h2>
            <p className="mt-2 break-words text-sm text-slate-500">
              Created on Azure {formatDate(detail.azure_created_at)}
            </p>
          </div>
          <button
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            href={detail.pr_url}
            target="_blank"
            rel="noreferrer"
          >
            Open in Azure DevOps
          </a>
          <button
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:opacity-50"
            disabled={queueing}
            onClick={onRereview}
          >
            {queueing ? "Queueing…" : "Re-review current commit"}
          </button>
        </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
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
              <section
                key={iteration.id}
                className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Status value={iteration.status} />
                  <time className="text-xs text-slate-500">
                    {formatDate(iteration.reviewed_at ?? iteration.created_at)}
                  </time>
                </div>
                <p className="mt-3 break-all font-mono text-xs text-slate-500">
                  {iteration.last_commit_id.slice(0, 12)}
                </p>
                {iteration.ai_summary && (
                  <p className="mt-2 break-words text-sm">{iteration.ai_summary}</p>
                )}
                {iteration.error_message && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                    {iteration.error_type && (
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">
                        {iteration.error_type} error
                      </p>
                    )}
                    <p className="mt-1 max-h-48 overflow-y-auto break-words whitespace-pre-wrap text-sm leading-5 text-red-700">
                      {iteration.error_message}
                    </p>
                  </div>
                )}
                {findings.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {findings.map((finding, index) => (
                      <div
                        key={`${finding.file}-${finding.line}-${index}`}
                        className="min-w-0 overflow-hidden rounded-lg border border-slate-100 bg-slate-50 p-3.5 text-sm"
                      >
                        <div className="flex flex-wrap gap-2 font-mono text-xs">
                          <span className="font-semibold uppercase text-accent">
                            {finding.severity}
                          </span>
                          <span className="min-w-0 break-all">
                            {finding.file}:{finding.line}
                          </span>
                        </div>
                        <p className="mt-2 break-words whitespace-pre-wrap">
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
        </div>
      </aside>
    </div>
  );
}

const emptyModelForm = {
  name: "",
  base_url: "https://api.openai.com/v1",
  api_key: "",
  model: "",
  input_cost_per_million: "0.15",
  output_cost_per_million: "0.60",
};

function ModelsPage({
  request,
  onError,
}: {
  request: <T,>(path: string, options?: RequestInit) => Promise<T>;
  onError: (message: string) => void;
}) {
  const [models, setModels] = useState<LlmModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyModelForm);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<{ items: LlmModelItem[] }>("/models");
      setModels(result.items);
    } catch (loadError) {
      onError(loadError instanceof Error ? loadError.message : "Unable to load models");
    } finally {
      setLoading(false);
    }
  }, [onError, request]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyModelForm);
  };

  const startEdit = (model: LlmModelItem) => {
    setEditingId(model.id);
    setForm({
      name: model.name,
      base_url: model.base_url,
      api_key: "",
      model: model.model,
      input_cost_per_million: String(model.input_cost_per_million),
      output_cost_per_million: String(model.output_cost_per_million),
    });
  };

  const saveModel = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    onError("");
    try {
      const payload = {
        name: form.name.trim(),
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        input_cost_per_million: Number(form.input_cost_per_million),
        output_cost_per_million: Number(form.output_cost_per_million),
      };
      if (editingId == null) {
        await request("/models", {
          method: "POST",
          body: JSON.stringify({ ...payload, api_key: form.api_key.trim() }),
        });
      } else {
        await request(`/models/${editingId}`, {
          method: "PUT",
          body: JSON.stringify({
            ...payload,
            api_key: form.api_key.trim() || null,
          }),
        });
      }
      resetForm();
      await loadModels();
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : "Unable to save model");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-accent">Settings</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
          AI models
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          OpenAI-compatible providers. The active model is used for all reviews.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="font-semibold text-slate-950">Configured models</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {models.map((model) => (
              <div
                key={model.id}
                className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{model.name}</p>
                    {model.is_active && (
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    {model.model}
                  </p>
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {model.base_url}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Key {model.api_key_masked} · $
                    {model.input_cost_per_million}/$
                    {model.output_cost_per_million} per 1M tokens
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!model.is_active && (
                    <button
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-800"
                      onClick={() =>
                        void request(`/models/${model.id}/activate`, {
                          method: "POST",
                        })
                          .then(loadModels)
                          .catch((activateError) =>
                            onError(
                              activateError instanceof Error
                                ? activateError.message
                                : "Unable to activate",
                            ),
                          )
                      }
                    >
                      Set active
                    </button>
                  )}
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => startEdit(model)}
                  >
                    Edit
                  </button>
                  <button
                    className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    onClick={() =>
                      void request(`/models/${model.id}`, { method: "DELETE" })
                        .then(() => {
                          if (editingId === model.id) resetForm();
                          return loadModels();
                        })
                        .catch((deleteError) =>
                          onError(
                            deleteError instanceof Error
                              ? deleteError.message
                              : "Unable to delete",
                          ),
                        )
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!loading && models.length === 0 && (
              <p className="p-8 text-center text-sm text-slate-500">
                No models yet. Add one to start reviewing.
              </p>
            )}
            {loading && (
              <p className="p-8 text-center text-sm text-slate-500">Loading…</p>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="font-semibold text-slate-950">
            {editingId == null ? "Add model" : "Edit model"}
          </h3>
          <form className="mt-4 space-y-3" onSubmit={(event) => void saveModel(event)}>
            {[
              ["name", "Display name", "MiMo / OpenAI"],
              ["base_url", "Base URL", "https://api.xiaomimimo.com/v1"],
              ["model", "Model id", "mimo-v2.6-pro"],
              ["api_key", editingId ? "API key (leave blank to keep)" : "API key", "sk-..."],
              ["input_cost_per_million", "Input $ / 1M tokens", "0.15"],
              ["output_cost_per_million", "Output $ / 1M tokens", "0.60"],
            ].map(([key, label, placeholder]) => (
              <label key={key} className="block text-sm">
                <span className="font-medium text-slate-700">{label}</span>
                <input
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-accent"
                  type={key === "api_key" ? "password" : "text"}
                  placeholder={placeholder}
                  value={form[key as keyof typeof form]}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  required={key !== "api_key" || editingId == null}
                />
              </label>
            ))}
            <div className="flex gap-2 pt-2">
              <button
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-50"
                disabled={saving}
              >
                {saving ? "Saving…" : editingId == null ? "Add model" : "Save changes"}
              </button>
              {editingId != null && (
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  onClick={resetForm}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [20, 40, 60, 100] as const;

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("token") ?? "");
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"dashboard" | "models">("dashboard");

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
      if (response.status === 204) {
        return undefined as T;
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
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
      });
      if (activeSearch) params.set("search", activeSearch);
      const [list, currentMetrics] = await Promise.all([
        request<{
          items: PullRequest[];
          total: number;
          page: number;
          page_size: number;
        }>(`/prs?${params}`),
        request<Metrics>("/metrics"),
      ]);
      setPrs(list.items);
      setTotal(list.total);
      setMetrics(currentMetrics);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load");
    } finally {
      setLoading(false);
    }
  }, [activeSearch, page, pageSize, request, token]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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
    setPage(1);
    setActiveSearch(search.trim());
  };

  const toggleAutoReview = async () => {
    if (!metrics) return;
    setTogglingAuto(true);
    setError("");
    try {
      const result = await request<{ auto_pr_review_enabled: boolean }>(
        "/metrics/auto-review",
        {
          method: "POST",
          body: JSON.stringify({ enabled: !metrics.auto_pr_review_enabled }),
        },
      );
      setMetrics({ ...metrics, auto_pr_review_enabled: result.auto_pr_review_enabled });
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : "Unable to toggle auto review",
      );
    } finally {
      setTogglingAuto(false);
    }
  };

  const fetchPrs = async () => {
    setFetching(true);
    setError("");
    try {
      await request("/prs/fetch", { method: "POST" });
      await loadDashboard();
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "Unable to fetch pull requests",
      );
    } finally {
      setFetching(false);
    }
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
    <main className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white shadow-sm">
            PR
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-slate-950">
              PR Reviewer
            </h1>
            <p className="text-xs text-slate-500">Azure DevOps workspace</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <nav className="mr-1 flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            <button
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === "dashboard"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
              onClick={() => {
                setView("dashboard");
                void loadDashboard();
              }}
            >
              Dashboard
            </button>
            <button
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === "models"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
              onClick={() => setView("models")}
            >
              Models
            </button>
          </nav>
          {view === "dashboard" && (
            <>
          <button
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            disabled={fetching}
            onClick={() => void fetchPrs()}
          >
            {fetching ? "Fetching…" : "Fetch PRs"}
          </button>
          <button
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold shadow-sm transition disabled:opacity-50 ${
              metrics?.auto_pr_review_enabled
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            disabled={!metrics || togglingAuto}
            onClick={() => void toggleAutoReview()}
          >
            {togglingAuto
              ? "Updating…"
              : metrics?.auto_pr_review_enabled
                ? "Auto review: on"
                : "Auto review: off"}
          </button>
            </>
          )}
          <button
            className="ml-1 text-sm font-medium text-slate-500 transition hover:text-slate-900"
            onClick={() => {
              sessionStorage.removeItem("token");
              setToken("");
            }}
          >
            Sign out
          </button>
        </div>
        </div>
      </header>

      {error && view === "models" && (
        <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        </div>
      )}

      {view === "models" ? (
        <ModelsPage
          request={request}
          onError={(message) => setError(message)}
        />
      ) : (
      <>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
        <p className="text-sm font-medium text-accent">Overview</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
          Review activity
        </h2>
        </div>
        {metrics?.active_model_name && (
          <p className="rounded-lg border border-teal-100 bg-teal-50 px-3 py-1.5 text-sm text-teal-800">
            Active model:{" "}
            <span className="font-semibold">{metrics.active_model_name}</span>
            {metrics.active_model_id ? (
              <span className="text-teal-700"> · {metrics.active_model_id}</span>
            ) : null}
          </p>
        )}
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["PRs reviewed", metrics?.total_prs_reviewed.toLocaleString() ?? "—"],
          ["Tokens used", metrics?.tokens_used.toLocaleString() ?? "—"],
          ["Total cost", `$${metrics?.estimated_cost_usd.toFixed(4) ?? "—"}`],
          ["Cost today", `$${metrics?.daily_cost_usd.toFixed(4) ?? "—"}`],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p className="text-xs font-medium text-slate-500">
              {label}
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {value}
            </p>
          </div>
        ))}
      </section>

      <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="font-semibold text-slate-950">Pull requests</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Created by you or assigned for your review
          </p>
        </div>
        <form className="flex" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="search">
            Search pull requests
          </label>
          <input
            id="search"
            className="w-56 rounded-l-lg border border-r-0 border-slate-300 bg-white px-3 py-2 text-sm transition focus:border-accent sm:w-64"
            placeholder="Search title, author, repository"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button className="rounded-r-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700">
            Search
          </button>
        </form>
      </div>

      {error && (
        <p className="mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr className="bg-slate-900 text-left text-xs text-slate-300">
              <th className="px-5 py-3.5 font-medium">Pull request</th>
              <th className="px-4 py-3.5 font-medium">Repository</th>
              <th className="px-4 py-3.5 font-medium">Author</th>
              <th className="px-4 py-3.5 font-medium">Review</th>
              <th className="px-5 py-3.5 font-medium">Created on Azure</th>
            </tr>
          </thead>
          <tbody>
            {groupPrsByMonth(prs).map((group) => (
              <Fragment key={group.label}>
                <tr>
                  <td
                    colSpan={5}
                    className="border-y border-teal-100 bg-teal-50/80 px-5 py-2.5"
                  >
                    <div className="flex items-center gap-3">
                      <span className="h-5 w-1 rounded-full bg-accent" />
                      <span className="text-sm font-semibold text-teal-900">
                        {group.label}
                      </span>
                      <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-teal-700 ring-1 ring-teal-200">
                        {group.items.length} PR
                        {group.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </td>
                </tr>
                {group.items.map((pr, index) => {
                  const status = pr.latest_iteration?.status;
                  return (
                    <tr
                      key={pr.pr_id}
                      className={`cursor-pointer border-l-4 transition ${rowAccent(status)} ${
                        index % 2 === 0 ? "bg-white" : "bg-slate-50/70"
                      } hover:bg-teal-50/60`}
                      onClick={() => void openDetail(pr.pr_id)}
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl bg-accent px-1.5 text-[11px] font-bold leading-none text-white shadow-sm">
                            {pr.pr_id}
                          </span>
                          <p className="pt-1.5 font-medium leading-snug text-slate-900">
                            {pr.title}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex max-w-[12rem] truncate rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200/80">
                          {pr.repository_name}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-700">
                        {pr.author_name}
                      </td>
                      <td className="px-4 py-4">
                        {status ? <Status value={status} /> : (
                          <span className="text-xs text-slate-400">No review</span>
                        )}
                      </td>
                      <td className="px-5 py-4 font-mono text-xs tabular-nums text-slate-500">
                        {formatDate(pr.azure_created_at)}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!loading && prs.length === 0 && (
          <p className="p-10 text-center text-sm text-slate-500">
            No pull requests found.
          </p>
        )}
        {loading && (
          <p className="p-10 text-center text-sm text-slate-500">Loading…</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <label className="flex items-center gap-2" htmlFor="page-size">
            Rows per page
            <select
              id="page-size"
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm"
              value={pageSize}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="text-slate-500">
            Showing{" "}
            <span className="font-medium text-slate-800">
              {rangeStart}-{rangeEnd}
            </span>{" "}
            of{" "}
            <span className="font-medium text-slate-800">
              {total.toLocaleString()}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-white disabled:opacity-40"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span className="min-w-24 rounded-lg bg-white px-3 py-1.5 text-center text-sm font-medium text-slate-700 ring-1 ring-slate-200">
            {Math.min(page, totalPages)} / {totalPages}
          </span>
          <button
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-white disabled:opacity-40"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      </div>
      </section>
      </div>
      </>
      )}

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
