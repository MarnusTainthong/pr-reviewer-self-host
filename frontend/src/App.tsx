import { FormEvent, Fragment, useCallback, useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

type Iteration = {
  id: number;
  last_commit_id: string;
  status: string;
  ai_summary: string | null;
  raw_ai_response: string | null;
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
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type ReviewRuleItem = {
  id: number;
  title: string;
  body: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
};

type FindingCategory =
  | "security"
  | "logic"
  | "bug"
  | "performance"
  | "api"
  | "reliability"
  | "data"
  | "test"
  | "readability"
  | "other";

type Finding = {
  file: string;
  line: number;
  severity: "critical" | "suggestion" | "nit";
  category?: FindingCategory;
  comment: string;
};

function parseDate(value: string) {
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T");
  const withZone =
    /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) || normalized.endsWith("Z")
      ? normalized
      : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? new Date(value) : date;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMonthLabel(value: string | null) {
  if (!value) return "Unknown date";
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(date);
}

function monthSortKey(value: string | null) {
  if (!value) return "0000-00";
  const date = parseDate(value);
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

const severityMeta: Record<
  Finding["severity"],
  { emoji: string; badge: string; tip: string }
> = {
  critical: {
    emoji: "🔴",
    badge: "bg-red-100 text-red-800 ring-red-700/20",
    tip: "Critical — bug, security, or data-loss risk. Fix before merge.",
  },
  suggestion: {
    emoji: "🟡",
    badge: "bg-amber-100 text-amber-900 ring-amber-700/20",
    tip: "Suggestion — worthwhile improvement, not a blocker.",
  },
  nit: {
    emoji: "⚪",
    badge: "bg-slate-100 text-slate-700 ring-slate-600/15",
    tip: "Nit — small style or clarity note. Optional.",
  },
};

function SeverityBadge({ severity }: { severity: Finding["severity"] }) {
  const meta = severityMeta[severity] ?? severityMeta.nit;
  return (
    <span className="group relative inline-flex">
      <span
        className={`inline-flex cursor-help items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${meta.badge}`}
        title={meta.tip}
        tabIndex={0}
      >
        <span aria-hidden="true">{meta.emoji}</span>
        {severity}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-56 -translate-x-1/2 rounded-md bg-slate-900 px-2.5 py-1.5 text-left text-[11px] font-medium normal-case tracking-normal text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {meta.tip}
      </span>
    </span>
  );
}

function CategoryBadge({ category }: { category: FindingCategory }) {
  return (
    <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-inset ring-slate-600/10">
      {category}
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
  reviewing,
  error,
}: {
  detail: PullRequestDetail;
  onClose: () => void;
  onRereview: () => void;
  queueing: boolean;
  reviewing: boolean;
  error: string;
}) {
  const latest = detail.iterations[0];
  const inProgress =
    reviewing ||
    latest?.status === "PENDING" ||
    latest?.status === "ATTEMPTING";
  const busy = queueing || inProgress;
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
            disabled={busy}
            onClick={onRereview}
          >
            {queueing
              ? "Queueing…"
              : inProgress
                ? "Reviewing…"
                : "Re-review"}
          </button>
        </div>
        {latest && (
          <p className="mt-3 font-mono text-xs text-slate-500">
            Latest commit {latest.last_commit_id.slice(0, 12)} · {latest.status}
          </p>
        )}
        {inProgress && (
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <span
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-sky-300 border-t-sky-700"
              aria-hidden
            />
            <div>
              <p className="font-semibold">AI review in progress</p>
              <p className="mt-0.5 text-sky-800">
                Waiting for the model to finish. This panel refreshes automatically.
              </p>
            </div>
          </div>
        )}
        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
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
                  <time className="font-mono text-xs tabular-nums text-slate-500">
                    {formatDate(iteration.reviewed_at ?? iteration.created_at)}
                  </time>
                </div>
                <p className="mt-3 break-all font-mono text-xs text-slate-500">
                  Commit {iteration.last_commit_id.slice(0, 12)}
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
                    {findings.map((finding, index) => {
                      const location = `${finding.file}:${finding.line}`;
                      const shortFile =
                        finding.file.split("/").pop() ?? finding.file;
                      return (
                        <div
                          key={`${finding.file}-${finding.line}-${index}`}
                          className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-3.5 text-sm shadow-sm"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <SeverityBadge severity={finding.severity} />
                            <CategoryBadge
                              category={finding.category ?? "other"}
                            />
                            <span className="group relative inline-flex min-w-0 max-w-full">
                              <span
                                className="cursor-help truncate rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600 ring-1 ring-inset ring-slate-600/10"
                                title={location}
                                tabIndex={0}
                              >
                                {shortFile}:{finding.line}
                              </span>
                              <span
                                role="tooltip"
                                className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-max max-w-xs break-all rounded-md bg-slate-900 px-2.5 py-1.5 text-left text-[11px] font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
                              >
                                {location}
                              </span>
                            </span>
                          </div>
                          <p className="mt-2.5 break-words whitespace-pre-wrap leading-6 text-slate-800">
                            {finding.comment}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  Reviewed {formatDate(iteration.reviewed_at ?? iteration.created_at)}
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
        input_cost_per_million: 0,
        output_cost_per_million: 0,
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
                    Key {model.api_key_masked}
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

const emptyRuleForm = {
  title: "",
  body: "",
  is_enabled: true,
};

function RulesPage({
  request,
  onError,
}: {
  request: <T,>(path: string, options?: RequestInit) => Promise<T>;
  onError: (message: string) => void;
}) {
  const [rules, setRules] = useState<ReviewRuleItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectingRules, setSelectingRules] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyRuleForm);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<{ items: ReviewRuleItem[] }>("/rules");
      setRules(result.items);
      setSelectedIds((current) => {
        const next = new Set<number>();
        for (const rule of result.items) {
          if (current.has(rule.id)) next.add(rule.id);
        }
        return next;
      });
    } catch (loadError) {
      onError(loadError instanceof Error ? loadError.message : "Unable to load rules");
    } finally {
      setLoading(false);
    }
  }, [onError, request]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyRuleForm);
  };

  const startEdit = (rule: ReviewRuleItem) => {
    setEditingId(rule.id);
    setForm({
      title: rule.title,
      body: rule.body,
      is_enabled: rule.is_enabled,
    });
  };

  const allSelected = rules.length > 0 && selectedIds.size === rules.length;

  const toggleSelected = (ruleId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(rules.map((rule) => rule.id)));
  };

  const finishSelectingRules = () => {
    setSelectingRules(false);
    setSelectedIds(new Set());
  };

  const exportRules = (items: ReviewRuleItem[]) => {
    if (items.length === 0) {
      onError("Select at least one rule to export");
      return;
    }
    onError("");
    const payload = {
      exported_at: new Date().toISOString(),
      rules: items.map((rule) => ({
        title: rule.title,
        body: rule.body,
        is_enabled: rule.is_enabled,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `review-rules-${stamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importRulesFromFile = async (file: File) => {
    setImporting(true);
    onError("");
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const rawRules = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { rules?: unknown }).rules)
          ? (parsed as { rules: unknown[] }).rules
          : null;
      if (!rawRules || rawRules.length === 0) {
        throw new Error("Import file must contain a non-empty rules array");
      }
      const rulesToImport = rawRules.map((item, index) => {
        if (!item || typeof item !== "object") {
          throw new Error(`Rule ${index + 1} is invalid`);
        }
        const row = item as {
          title?: unknown;
          body?: unknown;
          is_enabled?: unknown;
        };
        const title = typeof row.title === "string" ? row.title.trim() : "";
        const body = typeof row.body === "string" ? row.body.trim() : "";
        if (!title || !body) {
          throw new Error(`Rule ${index + 1} needs a title and body`);
        }
        return {
          title,
          body,
          is_enabled: typeof row.is_enabled === "boolean" ? row.is_enabled : true,
        };
      });
      const result = await request<{ imported: number }>("/rules/import", {
        method: "POST",
        body: JSON.stringify({ rules: rulesToImport }),
      });
      await loadRules();
      if (!result.imported) {
        onError("No rules were imported");
      }
    } catch (importError) {
      onError(
        importError instanceof Error
          ? importError.message
          : "Unable to import rules",
      );
    } finally {
      setImporting(false);
    }
  };

  const saveRule = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    onError("");
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body.trim(),
        is_enabled: form.is_enabled,
      };
      if (editingId == null) {
        await request("/rules", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else {
        await request(`/rules/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      resetForm();
      await loadRules();
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : "Unable to save rule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <div>
          <p className="text-sm font-medium text-accent">Settings</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Review rules
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Enabled rules are added to the reviewer prompt for every PR review.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold text-slate-950">Configured rules</h3>
              {!loading && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200/80">
                  {rules.length.toLocaleString()} rule
                  {rules.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label
                className={`rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ${
                  importing
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-slate-50"
                }`}
              >
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  disabled={importing}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importRulesFromFile(file);
                  }}
                />
                {importing ? "Importing…" : "Import"}
              </label>
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={rules.length === 0}
                onClick={() => exportRules(rules)}
              >
                Export all
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={rules.length === 0}
                onClick={() =>
                  selectingRules ? finishSelectingRules() : setSelectingRules(true)
                }
              >
                {selectingRules ? "Cancel" : "Select"}
              </button>
            </div>
          </div>
          {selectingRules && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-teal-100 bg-teal-50 px-5 py-3">
              <label className="flex items-center gap-2 text-sm font-medium text-teal-900">
                <input
                  type="checkbox"
                  className="rounded border-teal-300 text-accent focus:ring-accent"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                />
                Select all
              </label>
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-50"
                disabled={selectedIds.size === 0}
                onClick={() =>
                  exportRules(rules.filter((rule) => selectedIds.has(rule.id)))
                }
              >
                Export selected ({selectedIds.size})
              </button>
            </div>
          )}
          <div className="divide-y divide-slate-100">
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
              >
                <div className="flex min-w-0 flex-1 gap-3">
                  {selectingRules && (
                    <input
                      type="checkbox"
                      className="mt-1.5 rounded border-slate-300 text-accent focus:ring-accent"
                      checked={selectedIds.has(rule.id)}
                      onChange={() => toggleSelected(rule.id)}
                      aria-label={`Select ${rule.title}`}
                    />
                  )}
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 font-mono text-xs font-semibold tabular-nums text-slate-600">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{rule.title}</p>
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        rule.is_enabled
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {rule.is_enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">
                    {rule.body}
                  </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() =>
                      void request(`/rules/${rule.id}/toggle`, {
                        method: "POST",
                      })
                        .then(loadRules)
                        .catch((toggleError) =>
                          onError(
                            toggleError instanceof Error
                              ? toggleError.message
                              : "Unable to toggle",
                          ),
                        )
                    }
                  >
                    {rule.is_enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => startEdit(rule)}
                  >
                    Edit
                  </button>
                  <button
                    className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    onClick={() =>
                      void request(`/rules/${rule.id}`, { method: "DELETE" })
                        .then(() => {
                          if (editingId === rule.id) resetForm();
                          return loadRules();
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
            {!loading && rules.length === 0 && (
              <p className="p-8 text-center text-sm text-slate-500">
                No rules yet. Add project-specific guidance for reviews.
              </p>
            )}
            {loading && (
              <p className="p-8 text-center text-sm text-slate-500">Loading…</p>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="font-semibold text-slate-950">
            {editingId == null ? "Add rule" : "Edit rule"}
          </h3>
          <form className="mt-4 space-y-3" onSubmit={(event) => void saveRule(event)}>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Title</span>
              <input
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-accent"
                placeholder="Prefer early returns"
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                required
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Rule</span>
              <textarea
                className="mt-1.5 min-h-32 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-accent"
                placeholder="Flag deeply nested conditionals when an early return would be clearer."
                value={form.body}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    body: event.target.value,
                  }))
                }
                required
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="rounded border-slate-300 text-accent focus:ring-accent"
                checked={form.is_enabled}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    is_enabled: event.target.checked,
                  }))
                }
              />
              Enabled for reviews
            </label>
            <div className="flex gap-2 pt-2">
              <button
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-50"
                disabled={saving}
              >
                {saving ? "Saving…" : editingId == null ? "Add rule" : "Save changes"}
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
  const [reviewingPrId, setReviewingPrId] = useState<number | null>(null);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"dashboard" | "models" | "rules">("dashboard");

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

  useEffect(() => {
    if (!token || view !== "dashboard") return;
    const timer = window.setInterval(() => void loadDashboard(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadDashboard, token, view]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  const prRecordNumbers = new Map(
    prs.map((pr, index) => [pr.pr_id, (page - 1) * pageSize + index + 1]),
  );

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

  const refreshDetail = useCallback(
    async (prId: number) => {
      const next = await request<PullRequestDetail>(`/prs/${prId}`);
      setDetail(next);
      return next;
    },
    [request],
  );

  const detailStatus = detail?.iterations[0]?.status;
  const pollingPrId =
    reviewingPrId ??
    (detail &&
    detailStatus &&
    ["PENDING", "ATTEMPTING"].includes(detailStatus)
      ? detail.pr_id
      : null);

  useEffect(() => {
    if (pollingPrId == null) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await refreshDetail(pollingPrId);
        const nextStatus = next.iterations[0]?.status;
        if (nextStatus && !["PENDING", "ATTEMPTING"].includes(nextStatus)) {
          if (!cancelled) {
            setReviewingPrId(null);
            void loadDashboard();
          }
        }
      } catch {
        // Keep polling; transient network blips shouldn't stop the wait.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadDashboard, pollingPrId, refreshDetail]);

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
        <div className="flex flex-wrap items-center gap-4">
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
          <nav className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">
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
              Pull requests
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
            <button
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === "rules"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
              onClick={() => setView("rules")}
            >
              Rules
            </button>
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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

      {error && (view === "models" || view === "rules") && (
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
      ) : view === "rules" ? (
        <RulesPage
          request={request}
          onError={(message) => setError(message)}
        />
      ) : (
      <>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-accent">Azure DevOps</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
          Pull requests
        </h2>
      </div>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          ["PRs reviewed", metrics?.total_prs_reviewed.toLocaleString() ?? "—"],
          [
            "Active model",
            metrics?.active_model_name
              ? metrics.active_model_id
                ? `${metrics.active_model_name} · ${metrics.active_model_id}`
                : metrics.active_model_name
              : "None",
          ],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p className="text-xs font-medium text-slate-500">
              {label}
            </p>
            <p className="mt-2 break-words text-2xl font-semibold tracking-tight text-slate-950">
              {value}
            </p>
          </div>
        ))}
      </section>

      <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-slate-950">All pull requests</h2>
            {!loading && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200/80">
                {total.toLocaleString()} record
                {total === 1 ? "" : "s"}
              </span>
            )}
          </div>
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
        <table className="w-full min-w-[820px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr className="bg-accent text-left text-xs text-teal-50">
              <th className="w-14 px-4 py-3.5 font-medium">No.</th>
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
                    colSpan={6}
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
                  const recordNo = prRecordNumbers.get(pr.pr_id) ?? index + 1;
                  return (
                    <tr
                      key={pr.pr_id}
                      className={`cursor-pointer border-l-4 transition ${rowAccent(status)} ${
                        index % 2 === 0 ? "bg-white" : "bg-slate-50/70"
                      } hover:bg-teal-50/60`}
                      onClick={() => void openDetail(pr.pr_id)}
                    >
                      <td className="px-4 py-4 font-mono text-xs tabular-nums text-slate-500">
                        {recordNo}
                      </td>
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
          reviewing={reviewingPrId === detail.pr_id}
          error={error}
          onClose={() => {
            setDetail(null);
            setReviewingPrId(null);
          }}
          onRereview={async () => {
            setQueueing(true);
            setError("");
            try {
              await request(`/prs/${detail.pr_id}/re-review`, { method: "POST" });
              setReviewingPrId(detail.pr_id);
              await refreshDetail(detail.pr_id);
              void loadDashboard();
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
