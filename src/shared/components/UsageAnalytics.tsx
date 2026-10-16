"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import Card from "./Card";
import { CardSkeleton } from "./Loading";
import { fmtCompact as fmt, fmtFull, fmtCost } from "@/shared/utils/formatting";
import { readFetchErrorMessage } from "@/shared/utils/fetchError";
import {
  StatCard,
  CompactStatGrid,
  ActivityHeatmap,
  DailyTrendChart,
  AccountDonut,
  ApiKeyDonut,
  ApiKeyTable,
  MostActiveDay7d,
  WeeklySquares7d,
  ModelTable,
  ProviderCostDonut,
  ModelOverTimeChart,
  ProviderTable,
  ServiceTierBreakdown,
  ApiKeyFilterDropdown,
  CustomRangePicker,
  RequestCountByProviderDateTable,
} from "./analytics";

// ============================================================================
// Main Component
// ============================================================================

export default function UsageAnalytics() {
  const locale = useLocale();
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const [range, setRange] = useState("30d");
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Custom date range state
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const customPickerAnchorRef = useRef<HTMLDivElement>(null);

  // API key filter state
  const [selectedApiKeys, setSelectedApiKeys] = useState<string[]>([]);
  const [availableApiKeys, setAvailableApiKeys] = useState<{ id: string; name: string }[]>([]);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("range", range);
      if (providerFilter.trim()) params.set("provider", providerFilter.trim());
      if (modelFilter.trim()) params.set("model", modelFilter.trim());
      // This page labels the value as an estimate, so opt into token-price
      // equivalents for flat-rate subscriptions without changing API defaults.
      params.set("includeFlatRateEstimates", "true");
      if (range === "custom" && customStart && customEnd) {
        params.set("startDate", customStart);
        params.set("endDate", customEnd);
      }
      if (selectedApiKeys.length > 0) {
        params.set("apiKeyIds", selectedApiKeys.join(","));
      }
      const res = await fetch(`/api/usage/analytics?${params.toString()}`);
      if (!res.ok) throw new Error(await readFetchErrorMessage(res, tCommon("error")));
      const data = await res.json();
      setAnalytics(data);
      setError(null);

      // Update available keys from unfiltered data (only when no filter is active).
      if (selectedApiKeys.length === 0 && data.byApiKey?.length > 0) {
        const seen = new Set<string>();
        const keys: { id: string; name: string }[] = [];
        for (const k of data.byApiKey) {
          const id = k.apiKeyId || k.apiKeyName || tCommon("unknownProvider");
          const name = k.apiKeyName || k.apiKeyId || tCommon("unknownProvider");
          if (seen.has(id)) continue;
          seen.add(id);
          keys.push({ id, name });
        }
        setAvailableApiKeys(keys);
      }
    } catch (err) {
      setError((err as any).message);
    } finally {
      setLoading(false);
    }
  }, [range, customStart, customEnd, selectedApiKeys, providerFilter, modelFilter, tCommon]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchAnalytics(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchAnalytics]);

  const exportUsageHistory = useCallback(() => {
    const params = new URLSearchParams({ range });
    if (providerFilter.trim()) params.set("provider", providerFilter.trim());
    if (modelFilter.trim()) params.set("model", modelFilter.trim());
    if (range === "custom" && customStart && customEnd) {
      params.set("startDate", customStart);
      params.set("endDate", customEnd);
    }
    if (selectedApiKeys.length > 0) params.set("apiKeyIds", selectedApiKeys.join(","));
    window.location.assign(`/api/usage/export?${params.toString()}`);
  }, [range, customStart, customEnd, selectedApiKeys, providerFilter, modelFilter]);

  const handleRangeSelect = useCallback((value: string) => {
    if (value === "custom") {
      setShowCustomPicker(true);
    } else {
      setRange(value);
      setShowCustomPicker(false);
    }
  }, []);

  const handleCustomApply = useCallback((start: string, end: string) => {
    setCustomStart(start);
    setCustomEnd(end);
    setRange("custom");
    setShowCustomPicker(false);
  }, []);

  const handleUsageImport = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setImportMessage("");
      if (file.size > 10 * 1024 * 1024) {
        setImportMessage("Import file exceeds the 10 MB limit.");
        return;
      }
      setImporting(true);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const rows = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as any).events)
            ? (parsed as any).events
            : null;
        if (!rows || rows.length > 5000) {
          throw new Error("Choose normalized JSON with at most 5,000 usage events.");
        }
        // Send only usage metadata fields; prompt text, completions, credentials, and
        // all other source-file content stay in the browser and never leave the file.
        const allowed = [
          "eventId",
          "sourceLabel",
          "timestamp",
          "provider",
          "model",
          "sourceKind",
          "inputStatus",
          "outputStatus",
          "cacheReadStatus",
          "cacheCreationStatus",
          "reasoningStatus",
          "noCacheStatus",
          "promptTokens",
          "completionTokens",
          "sourceReportedInput",
          "cacheReadTokens",
          "cacheCreationTokens",
          "reasoningTokens",
          "noCacheTokens",
        ];
        const events = rows
          .filter((row: unknown) => row && typeof row === "object" && !Array.isArray(row))
          .map((row: Record<string, unknown>) =>
            Object.fromEntries(allowed.filter((key) => key in row).map((key) => [key, row[key]]))
          );
        const response = await fetch("/api/usage/analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Import failed.");
        setImportMessage(`Imported ${result.imported} records; skipped ${result.skipped}.`);
        await fetchAnalytics();
      } catch (err) {
        setImportMessage((err as Error).message || "Could not read that JSON file.");
      } finally {
        setImporting(false);
        if (importInputRef.current) importInputRef.current.value = "";
      }
    },
    [fetchAnalytics]
  );

  // Format custom range label for display
  const customRangeLabel = useMemo(() => {
    if (range !== "custom" || !customStart || !customEnd) return null;
    const fmt = (iso: string) => {
      const d = new Date(iso);
      return d.toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };
    return `${fmt(customStart)} — ${fmt(customEnd)}`;
  }, [range, customStart, customEnd, locale]);

  const ranges = [
    { value: "1d", label: t("period1D") },
    { value: "7d", label: t("period7D") },
    { value: "30d", label: t("period30D") },
    { value: "90d", label: t("period90D") },
    { value: "ytd", label: t("periodYTD") },
    { value: "all", label: t("periodAll") },
  ];

  const topModel = useMemo(() => {
    const models = analytics?.byModel || [];
    return models.length > 0 ? models[0].model : "—";
  }, [analytics]);

  const topProvider = useMemo(() => {
    const providers = analytics?.byProvider || [];
    return providers.length > 0 ? providers[0].provider : "—";
  }, [analytics]);

  const busiestDay = useMemo(() => {
    const wp = analytics?.weeklyPattern || [];
    if (!wp.length) return "—";
    const max = wp.reduce((a, b) => (a.avgTokens > b.avgTokens ? a : b), wp[0]);
    if (max.avgTokens <= 0) return "—";
    const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(max.day);
    if (weekdayIndex < 0) return max.day;
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
      new Date(2024, 0, 7 + weekdayIndex)
    );
  }, [analytics, locale]);

  const providerCount = useMemo(() => {
    return (analytics?.byProvider || []).length;
  }, [analytics]);

  const providerDiversity = useMemo(() => {
    const providers = analytics?.byProvider || [];
    if (providers.length <= 1) return 0;

    let totalCalls = 0;
    for (const p of providers) {
      totalCalls += p.totalRequests || p.apiCalls || 0;
    }
    if (totalCalls === 0) return 0;

    let h = 0;
    for (const p of providers) {
      const p_i = (p.totalRequests || p.apiCalls || 0) / totalCalls;
      if (p_i > 0) h -= p_i * Math.log2(p_i);
    }

    const maxH = Math.log2(providers.length);
    return maxH > 0 ? (h / maxH) * 100 : 0;
  }, [analytics]);

  if (loading && !analytics) return <CardSkeleton />;
  if (error)
    return (
      <Card className="p-6 text-center text-red-500">
        {tCommon("errorShort")}: {error}
      </Card>
    );

  const s = analytics?.summary || {};

  // ── Derived insight values ──
  const avgTokensPerReq = s.totalRequests > 0 ? Math.round(s.totalTokens / s.totalRequests) : 0;
  const costPerReq =
    s.costKnown === false || s.totalRequests <= 0
      ? null
      : Number(s.totalCost || 0) / s.totalRequests;
  const ioRatio = s.completionTokens > 0 ? (s.promptTokens / s.completionTokens).toFixed(1) : "—";

  return (
    <div className="flex flex-col gap-5 min-w-0">
      {/* Header + Filters */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[22px]">analytics</span>
          {t("usageAnalyticsTitle")}
        </h2>
        <div className="flex items-center gap-2.5">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void handleUsageImport(event.target.files?.[0])}
          />
          <button
            type="button"
            disabled={importing}
            onClick={() => importInputRef.current?.click()}
            className="px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
            title="Import normalized usage JSON; prompt and response text are not uploaded"
          >
            {importing ? "Importing…" : "Import usage JSON"}
          </button>
          <button
            type="button"
            onClick={exportUsageHistory}
            className="px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/5"
            title="Export prompt-free usage metadata for the selected range and API keys"
          >
            Export usage JSON
          </button>
          {/* API Key Filter */}
          <ApiKeyFilterDropdown
            available={availableApiKeys}
            selected={selectedApiKeys}
            onChange={setSelectedApiKeys}
          />

          {/* Period Selector + Custom */}
          <div
            className="relative flex items-center gap-1 bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-1 border border-black/5 dark:border-white/5"
            ref={customPickerAnchorRef}
          >
            {ranges.map((r) => (
              <button
                key={r.value}
                onClick={() => handleRangeSelect(r.value)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                  range === r.value
                    ? "bg-primary text-white shadow-sm"
                    : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={() => handleRangeSelect("custom")}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-all flex items-center gap-1 ${
                range === "custom"
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              <span className="material-symbols-outlined text-[13px]">date_range</span>
              {customRangeLabel || t("customRange")}
              {range === "custom" && customRangeLabel && (
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRange("30d");
                    setCustomStart("");
                    setCustomEnd("");
                  }}
                  className="ml-0.5 opacity-70 hover:opacity-100"
                >
                  <span className="material-symbols-outlined text-[11px]">close</span>
                </span>
              )}
            </button>

            {/* Custom Range Picker Popover */}
            {showCustomPicker && (
              <CustomRangePicker
                start={customStart}
                end={customEnd}
                onApply={handleCustomApply}
                onClose={() => setShowCustomPicker(false)}
              />
            )}
          </div>
        </div>
      </div>

      {importMessage && (
        <div className="text-xs text-text-muted" role="status">
          {importMessage} Read the{" "}
          <a className="text-primary underline" href="/docs/guides/TOKEN_USAGE">
            token usage setup guide
          </a>
          .
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Provider filter
          <input
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            placeholder="All providers"
            className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-text-main"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Model filter
          <input
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            placeholder="All models"
            className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-text-main"
          />
        </label>
      </div>

      <p className="text-xs text-text-muted rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
        Existing summary cards, charts, and provider/model rollups can combine reported and
        estimated counts. The provenance tables below split those values by status. Older rows whose
        source cannot be recovered remain legacy unknown. Cost values marked ≈ are estimates from
        configured token prices; unpriced or flat-rate usage shows —. Token counts are not
        subscription quota totals.
      </p>

      {/* Primary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon="generating_tokens"
          label={t("totalTokens")}
          value={fmt(s.totalTokens)}
          tooltip={fmtFull(s.totalTokens)}
          subValue={`${fmtFull(s.totalRequests)} ${t("chartRequests")}`}
        />
        <StatCard
          icon="input"
          label={t("inputTokens")}
          value={fmt(s.promptTokens)}
          tooltip={fmtFull(s.promptTokens)}
          color="text-primary"
        />
        <StatCard
          icon="output"
          label={t("outputTokens")}
          value={fmt(s.completionTokens)}
          tooltip={fmtFull(s.completionTokens)}
          color="text-emerald-500"
        />
        <StatCard
          icon="payments"
          label={t("estCost")}
          value={s.costKnown === false ? "—" : `≈ ${fmtCost(s.totalCost)}`}
          tooltip={
            s.costKnown === false
              ? "Unavailable: no complete matching pricing data is available for this range, or subscription cost is not a per-request token price."
              : "Estimate: calculated from OmniRoute's configured token prices; provider billing may differ."
          }
          color="text-amber-500"
        />
      </div>

      {/* Secondary Metrics — compact grid with sections */}
      <CompactStatGrid
        sections={[
          {
            title: t("infraTitle"),
            items: [
              { icon: "group", label: t("infraAccounts"), value: s.uniqueAccounts || 0 },
              {
                icon: "dns",
                label: t("infraProviders"),
                value: providerCount,
                color: "text-indigo-500",
              },
              { icon: "vpn_key", label: t("infraApiKeys"), value: s.uniqueApiKeys || 0 },
              { icon: "model_training", label: t("infraModels"), value: s.uniqueModels || 0 },
            ],
          },
          {
            title: t("perfTitle"),
            items: [
              {
                icon: "speed",
                label: t("perfAvgTokens"),
                value: fmt(avgTokensPerReq),
                tooltip: `tokens : ${fmtFull(avgTokensPerReq)} tokens`,
                color: "text-cyan-500",
              },
              {
                icon: "request_quote",
                label: t("perfCostReq"),
                value: costPerReq === null ? "—" : `≈ ${fmtCost(costPerReq)}`,
                tooltip: costPerReq
                  ? `cost : $${Number(costPerReq).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`
                  : undefined,
                color: "text-orange-500",
              },
              {
                icon: "compare_arrows",
                label: t("perfIoRatio"),
                value: `${ioRatio}x`,
                color: "text-violet-500",
              },
              {
                icon: "bolt",
                label: t("perfFastReq"),
                value: fmt(s.fastRequests || 0),
                tooltip: `requests : ${fmtFull(s.fastRequests || 0)} requests`,
                color: "text-sky-500",
              },
            ],
          },
          {
            title: t("highlightsTitle"),
            wideValues: true,
            items: [
              {
                icon: "star",
                label: t("highlightsTopModel"),
                value: topModel,
                color: "text-pink-500",
              },
              {
                icon: "cloud",
                label: t("highlightsTopProvider"),
                value: topProvider,
                color: "text-teal-500",
              },
              {
                icon: "today",
                label: t("highlightsBusiestDay"),
                value: busiestDay,
                color: "text-rose-500",
              },
              {
                icon: "network_node",
                label: t("highlightsDiversity"),
                value: `${providerDiversity.toFixed(1)}%`,
                color: "text-sky-500",
              },
              {
                icon: "swap_horiz",
                label: t("highlightsFallbackRate"),
                value: `${Number(s.fallbackRatePct || 0).toFixed(1)}%`,
                color: "text-amber-500",
              },
            ],
          },
        ]}
      />

      {/* Activity Heatmap + Weekly Widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 items-stretch">
        <ActivityHeatmap activityMap={analytics?.activityMap} />
        <div className="flex flex-col gap-4">
          <MostActiveDay7d activityMap={analytics?.activityMap} />
          <WeeklySquares7d activityMap={analytics?.activityMap} />
        </div>
      </div>

      {/* Token & Cost Trend + Provider Cost Donut */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DailyTrendChart dailyTrend={analytics?.dailyTrend} />
        <ProviderCostDonut byProvider={analytics?.byProvider} />
      </div>

      {/* Fast / Standard service tier split */}
      <ServiceTierBreakdown byServiceTier={analytics?.byServiceTier} summary={s} />

      {/* Model Usage Over Time (stacked area) */}
      <ModelOverTimeChart
        dailyByModel={analytics?.dailyByModel}
        modelNames={analytics?.modelNames}
      />

      {/* Account Donut + API Key Donut */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AccountDonut byAccount={analytics?.byAccount} />
        <ApiKeyDonut byApiKey={analytics?.byApiKey} />
      </div>

      {/* Provider Breakdown Table */}
      <ProviderTable byProvider={analytics?.byProvider} />

      {/* Request Count by Provider & Date — #4009 (some providers bill per-request) */}
      <RequestCountByProviderDateTable range={range} />

      {/* API Key Table */}
      <ApiKeyTable byApiKey={analytics?.byApiKey} />

      {/* Model Breakdown Table */}
      <ModelTable byModel={analytics?.byModel} summary={s} />

      <TokenUsageProvenance
        sources={analytics?.tokenSources || []}
        connections={analytics?.usageConnections || []}
        daily={analytics?.dailyTokenUsage || []}
        monthly={analytics?.monthlyTokenUsage || []}
        breakdowns={{
          providers: analytics?.tokenUsageByProvider || [],
          models: analytics?.tokenUsageByModel || [],
        }}
      />
    </div>
  );
}

function TokenUsageProvenance({ sources, connections, daily, monthly, breakdowns }: any) {
  const number = (value: unknown) => Number(value || 0).toLocaleString();
  const reported = (value: unknown) =>
    value == null ? "—" : `${Number(value).toLocaleString()} reported`;
  const lastSeen = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString() : "Never recorded";
  const sourceLabel = (kind: string) =>
    ({
      local: "Local model",
      "cloud-api": "Cloud API",
      subscription: "Subscription-backed",
      imported: "Imported",
      unknown: "Unknown source",
    })[kind] || kind;

  return (
    <Card className="p-5 flex flex-col gap-5">
      <div>
        <h3 className="font-semibold">Token source and count provenance</h3>
        <p className="text-xs text-text-muted mt-1">
          Reported and estimated counts are split. Pre-existing rows without provenance remain
          labeled as legacy unknown.
        </p>
      </div>

      <div className="overflow-x-auto">
        <h4 className="text-sm font-semibold mb-2">Configured provider connections</h4>
        {connections.length === 0 ? (
          <p className="text-xs text-text-muted">No provider connections are configured.</p>
        ) : (
          <table className="w-full text-xs min-w-[600px]">
            <thead className="text-text-muted text-left">
              <tr>
                <th className="py-2">Provider / connection</th>
                <th>Source</th>
                <th>Status</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection: any, index: number) => (
                <tr
                  key={`${connection.provider}-${connection.connectionName || index}`}
                  className="border-t border-black/5 dark:border-white/5"
                >
                  <td className="py-2 font-mono">
                    {connection.connectionName || connection.provider}
                  </td>
                  <td>{sourceLabel(connection.sourceKind)}</td>
                  <td>{connection.state}</td>
                  <td>{lastSeen(connection.lastUpdate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="overflow-x-auto">
        <h4 className="text-sm font-semibold mb-2">Provider and model totals by provenance</h4>
        <table className="w-full text-xs min-w-[900px]">
          <thead className="text-text-muted text-left">
            <tr>
              <th className="py-2">Group</th>
              <th>Name</th>
              <th>Source</th>
              <th>Collection</th>
              <th>Requests</th>
              <th>Input reported</th>
              <th>Input estimated</th>
              <th>Input unknown</th>
              <th>Output reported</th>
              <th>Output estimated</th>
              <th>Output unknown</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...breakdowns.providers.map((row: any) => ({ ...row, dimension: "Provider" })),
              ...breakdowns.models.map((row: any) => ({ ...row, dimension: "Model" })),
            ].map((row: any, index: number) => (
              <tr
                key={`${row.dimension}-${row.name}-${row.sourceKind}-${row.ingestion}-${index}`}
                className="border-t border-black/5 dark:border-white/5"
              >
                <td className="py-2">{row.dimension}</td>
                <td className="font-mono">{row.name}</td>
                <td>{sourceLabel(row.sourceKind)}</td>
                <td>
                  {row.ingestion === "legacy"
                    ? "Rolled-up history"
                    : row.ingestion === "import"
                      ? "User import"
                      : "Routed requests"}
                </td>
                <td>{number(row.requests)}</td>
                <td>{number(row.inputReported)}</td>
                <td>{number(row.inputEstimated)}</td>
                <td>{number(row.inputLegacyUnknown)}</td>
                <td>{number(row.outputReported)}</td>
                <td>{number(row.outputEstimated)}</td>
                <td>{number(row.outputLegacyUnknown)}</td>
              </tr>
            ))}
            {breakdowns.providers.length === 0 && breakdowns.models.length === 0 && (
              <tr>
                <td colSpan={11} className="py-2 text-text-muted">
                  No provider or model usage matches this range and filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <h4 className="text-sm font-semibold mb-2">Captured usage sources</h4>
        {sources.length === 0 ? (
          <p className="text-xs text-text-muted">No usage events match this range and filter.</p>
        ) : (
          <table className="w-full text-xs min-w-[900px]">
            <thead className="text-text-muted text-left">
              <tr>
                <th className="py-2">Source</th>
                <th>Collection</th>
                <th>Status</th>
                <th>Last update</th>
                <th>Requests</th>
                <th>Input reported</th>
                <th>Input estimated</th>
                <th>Provider-reported input replaced</th>
                <th>Input unavailable</th>
                <th>Output reported</th>
                <th>Output estimated</th>
                <th>Output unavailable</th>
                <th>Cache read reported</th>
                <th>Cache read unavailable</th>
                <th>Cache creation reported</th>
                <th>Cache creation unavailable</th>
                <th>Reasoning reported</th>
                <th>Reasoning unavailable</th>
                <th>No-cache input reported</th>
                <th>No-cache unavailable</th>
                <th>Legacy unknown</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source: any, index: number) => (
                <tr
                  key={`${source.sourceKind}-${source.ingestion}-${index}`}
                  className="border-t border-black/5 dark:border-white/5"
                >
                  <td className="py-2">
                    {sourceLabel(source.sourceKind)} · {source.sourceLabel}
                  </td>
                  <td>
                    {source.ingestion === "import"
                      ? "User import"
                      : source.ingestion === "legacy"
                        ? "Rolled-up history"
                        : "Routed requests"}
                  </td>
                  <td>
                    {source.status === "recent"
                      ? "Activity in last 24 hours"
                      : "No activity in last 24 hours"}
                  </td>
                  <td>{lastSeen(source.lastUpdate)}</td>
                  <td>{number(source.requests)}</td>
                  <td>{number(source.inputReported)} reported</td>
                  <td>{number(source.inputEstimated)} estimated</td>
                  <td>
                    {source.inputSourceReported == null
                      ? "—"
                      : `${number(source.inputSourceReported)} reported by provider`}
                  </td>
                  <td>{number(source.inputUnavailableRequests)} requests</td>
                  <td>{number(source.outputReported)} reported</td>
                  <td>{number(source.outputEstimated)} estimated</td>
                  <td>{number(source.outputUnavailableRequests)} requests</td>
                  <td>{reported(source.cacheReadReported)}</td>
                  <td>{number(source.cacheReadUnavailableRequests)} requests</td>
                  <td>{reported(source.cacheCreationReported)}</td>
                  <td>{number(source.cacheCreationUnavailableRequests)} requests</td>
                  <td>{reported(source.reasoningReported)}</td>
                  <td>{number(source.reasoningUnavailableRequests)} requests</td>
                  <td>{reported(source.noCacheReported)}</td>
                  <td>{number(source.noCacheUnavailableRequests)} requests</td>
                  <td>
                    {number(source.inputLegacyUnknown)} in / {number(source.outputLegacyUnknown)}{" "}
                    out unknown
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="overflow-x-auto">
        <h4 className="text-sm font-semibold mb-2">Daily token totals by source and provenance</h4>
        <p className="text-xs text-text-muted mb-2">
          These rows follow the current date, API-key, provider, and model filters. Additional token
          categories appear only when the source reported them.
        </p>
        <table className="w-full text-xs min-w-[1000px]">
          <thead className="text-text-muted text-left">
            <tr>
              <th className="py-2">Day (UTC)</th>
              <th>Source</th>
              <th>Collection</th>
              <th>Requests</th>
              <th>Input reported</th>
              <th>Input estimated</th>
              <th>Input unknown</th>
              <th>Output reported</th>
              <th>Output estimated</th>
              <th>Output unknown</th>
              <th>Cache read</th>
              <th>Cache creation</th>
              <th>Reasoning</th>
              <th>No-cache input</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((row: any, index: number) => (
              <tr
                key={`${row.day}-${row.sourceKind}-${row.ingestion}-${index}`}
                className="border-t border-black/5 dark:border-white/5"
              >
                <td className="py-2">{row.day}</td>
                <td>{sourceLabel(row.sourceKind)}</td>
                <td>
                  {row.ingestion === "legacy"
                    ? "Rolled-up history"
                    : row.ingestion === "import"
                      ? "User import"
                      : "Routed requests"}
                </td>
                <td>{number(row.requests)}</td>
                <td>{number(row.inputReported)}</td>
                <td>{number(row.inputEstimated)}</td>
                <td>{number(row.inputLegacyUnknown)}</td>
                <td>{number(row.outputReported)}</td>
                <td>{number(row.outputEstimated)}</td>
                <td>{number(row.outputLegacyUnknown)}</td>
                <td>{reported(row.cacheReadReported)}</td>
                <td>{reported(row.cacheCreationReported)}</td>
                <td>{reported(row.reasoningReported)}</td>
                <td>{reported(row.noCacheReported)}</td>
              </tr>
            ))}
            {daily.length === 0 && (
              <tr>
                <td colSpan={14} className="py-2 text-text-muted">
                  No daily usage in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <h4 className="text-sm font-semibold mb-2">Monthly token totals by provenance</h4>
        <table className="w-full text-xs min-w-[850px]">
          <thead className="text-text-muted text-left">
            <tr>
              <th className="py-2">Month (UTC)</th>
              <th>Source</th>
              <th>Collection</th>
              <th>Requests</th>
              <th>Input reported</th>
              <th>Input estimated</th>
              <th>Input count replaced</th>
              <th>Input unavailable requests</th>
              <th>Output reported</th>
              <th>Output estimated</th>
              <th>Output unavailable requests</th>
              <th>Cache read reported</th>
              <th>Cache creation reported</th>
              <th>Reasoning reported</th>
              <th>No-cache input reported</th>
              <th>Legacy unknown input / output</th>
            </tr>
          </thead>
          <tbody>
            {monthly.map((row: any) => (
              <tr
                key={`${row.month}-${row.sourceKind}-${row.ingestion}`}
                className="border-t border-black/5 dark:border-white/5"
              >
                <td className="py-2">{row.month}</td>
                <td>{sourceLabel(row.sourceKind)}</td>
                <td>
                  {row.ingestion === "legacy"
                    ? "Rolled-up history"
                    : row.ingestion === "import"
                      ? "User import"
                      : "Routed requests"}
                </td>
                <td>{number(row.requests)}</td>
                <td>{number(row.inputReported)} reported</td>
                <td>{number(row.inputEstimated)} estimated</td>
                <td>
                  {row.inputSourceReported == null
                    ? "—"
                    : `${number(row.inputSourceReported)} provider-reported`}
                </td>
                <td>{number(row.inputUnavailableRequests)} requests</td>
                <td>{number(row.outputReported)} reported</td>
                <td>{number(row.outputEstimated)} estimated</td>
                <td>{number(row.outputUnavailableRequests)} requests</td>
                <td>{reported(row.cacheReadReported)}</td>
                <td>{reported(row.cacheCreationReported)}</td>
                <td>{reported(row.reasoningReported)}</td>
                <td>{reported(row.noCacheReported)}</td>
                <td>
                  {number(row.inputLegacyUnknown)} / {number(row.outputLegacyUnknown)}
                </td>
              </tr>
            ))}
            {monthly.length === 0 && (
              <tr>
                <td colSpan={16} className="py-2 text-text-muted">
                  No monthly usage in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-muted">
        Connection status uses OmniRoute’s configured/test status; last update is the latest
        recorded test, request, or captured usage event. No activity does not mean the provider is
        offline.
      </p>
    </Card>
  );
}
