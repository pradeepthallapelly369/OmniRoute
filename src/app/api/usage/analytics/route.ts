import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
export const dynamic = "force-dynamic";
import { getProviderById, isLocalProvider } from "@/shared/constants/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeys } from "@/lib/db/apiKeys";
import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import {
  buildUnifiedSource,
  buildPresetUnifiedSource,
  getUsageSummary,
  getDailyUsage,
  getDailyCostRows,
  getHeatmapRows,
  getModelUsageRows,
  getProviderCostRows,
  getProviderUsageRows,
  getAccountCostRows,
  getAccountUsageRows,
  getApiKeyUsageRows,
  getServiceTierUsageRows,
  getApiKeyMetadataRows,
  getWeeklyPatternRows,
  getPresetCostModelRows,
} from "@/lib/db/usageAnalytics";
import { getFallbackStats, getErrorTypeBreakdown } from "@/lib/db/callLogStats";
import { buildByProviderRows } from "@/lib/usage/providerDisplayNames";
import { isFlatRateProvider } from "@/lib/usage/flatRateProviders";
import { toNumber } from "@/shared/utils/numeric";
import {
  getTokenUsageBreakdownRows,
  getTokenUsageDailyRows,
  getTokenUsageMonthlyRows,
  getTokenUsageSourceRows,
  getUsageConnectionStatusRows,
} from "@/lib/db/tokenUsageAnalytics";
import { saveRequestUsage } from "@/lib/usage/usageHistory";

function getRangeStartIso(range: string): string | null {
  const end = new Date();
  const start = new Date(end);

  switch (range) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "90d":
      start.setDate(start.getDate() - 90);
      break;
    case "180d":
      start.setDate(start.getDate() - 180);
      break;
    case "365d":
      start.setDate(start.getDate() - 365);
      break;
    case "ytd":
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      break;
    case "all":
    default:
      return null;
  }

  return start.toISOString();
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type PricingByProvider = Record<string, Record<string, Record<string, unknown>>>;
type UsageRows = Array<Record<string, unknown>>;
type ComputeCostFromPricing = (
  pricing: Record<string, unknown> | null | undefined,
  tokens: Record<string, number | undefined> | null | undefined,
  options?: Record<string, unknown>
) => number;
type GetCodexFastCostMultiplier = (
  provider: string | null | undefined,
  model: string | null | undefined,
  serviceTier: string | null | undefined
) => number;

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeServiceTier(value: unknown): "standard" | "priority" | "flex" {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "flex") return "flex";
  return "standard";
}

function getServiceTierLabelId(serviceTier: string): string {
  return normalizeServiceTier(serviceTier);
}

function appendWhereCondition(whereClause: string, condition: string): string {
  return whereClause ? `${whereClause} AND (${condition})` : `WHERE (${condition})`;
}

function findKeyInsensitive(obj: Record<string, any> | undefined | null, key: string): any {
  if (!obj || !key) return undefined;
  return obj[key.toLowerCase()];
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function makeApiKeyUsageGroup(apiKeyId: string, fallbackName: string): string {
  return apiKeyId ? `id:${apiKeyId}` : `name:${fallbackName}`;
}

function addApiKeyAlias(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) target.add(trimmed);
}

function stripCodexEffortSuffix(model: string): string {
  return model.replace(/-(?:xhigh|high|medium|low|none)$/i, "");
}

function getPricingModelCandidates(
  model: string,
  normalizeModelName: (model: string) => string
): string[] {
  const normalizedModel = normalizeModelName(model);
  const lowerModel = model.toLowerCase();
  const lowerNormalized = normalizedModel.toLowerCase();
  const hyphenModel = lowerModel.replace(/\./g, "-");
  const hyphenNormalized = lowerNormalized.replace(/\./g, "-");
  const effortBaseModel = stripCodexEffortSuffix(lowerNormalized);

  return uniqueValues([
    lowerModel,
    lowerNormalized,
    hyphenModel,
    hyphenNormalized,
    effortBaseModel,
    effortBaseModel.replace(/\./g, "-"),
    lowerNormalized === "codex-auto-review" ? "gpt-5.5" : null,
  ]);
}

function resolveModelPricing(
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  providerRaw: string,
  model: string,
  normalizeModelName: (model: string) => string
): Record<string, unknown> | null {
  const pLower = (providerRaw || "").toLowerCase();

  let providerPricing = findKeyInsensitive(pricingByProvider, pLower);

  if (!providerPricing) {
    // providerAliasMap maps ID -> ALIAS. So if pLower is "codex", alias is "cx".
    const alias = providerAliasMap[pLower];
    if (alias) {
      providerPricing = findKeyInsensitive(pricingByProvider, alias);
    }
  }

  if (!providerPricing) {
    // In case pLower was ALIAS and we want to try the ID (reverse search values)
    for (const [id, alias] of Object.entries(providerAliasMap)) {
      if (alias.toLowerCase() === pLower) {
        providerPricing = findKeyInsensitive(pricingByProvider, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) {
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) {
      providerPricing = findKeyInsensitive(pricingByProvider, np);
    }
  }

  // Hardcoded known fallbacks
  if (!providerPricing) {
    if (pLower === "antigravity") providerPricing = findKeyInsensitive(pricingByProvider, "ag");
  }

  const modelCandidates = getPricingModelCandidates(model, normalizeModelName);

  const tryFind = (prov: Record<string, unknown> | null | undefined) => {
    if (!prov || typeof prov !== "object") return null;
    for (const candidate of modelCandidates) {
      const pricing = findKeyInsensitive(prov as Record<string, unknown>, candidate);
      if (pricing) return pricing;
    }
    return null;
  };

  let pricing = providerPricing ? tryFind(providerPricing) : null;

  if (!pricing) {
    // Global fallback: search all providers for this exact model (helps with aliases)
    for (const prov of Object.values(pricingByProvider)) {
      const found = tryFind(prov as Record<string, unknown>);
      if (found) {
        pricing = found;
        break;
      }
    }
  }

  // Short-circuit :free models to $0 (they have no pricing entry → should not fall back to arbitrary rates)
  if (!pricing && model.endsWith(":free")) {
    return null;
  }

  // Last resort fallback for historical usage (e.g. "gpt-4" missing, matches "gpt-4.1")
  if (!pricing && providerPricing && typeof providerPricing === "object") {
    for (const [key, val] of Object.entries(providerPricing as Record<string, unknown>)) {
      const lm = model.toLowerCase();
      if (key.includes(lm) || lm.includes(key)) {
        pricing = val;
        break;
      }
    }
  }

  return pricing as Record<string, unknown> | null;
}

function computeUsageRowCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  normalizeModelName: (model: string) => string,
  computeCostFromPricing: ComputeCostFromPricing,
  flatRateAsZero = true
): number {
  const provider = toStringValue(row.provider);
  const model = toStringValue(row.model);
  if (!provider || !model) return 0;
  const serviceTier = normalizeServiceTier(row.serviceTier ?? row.service_tier);
  const isAggregated = toNumber(row.isAggregated ?? row.is_aggregated) > 0;
  const storedCost = toNumber(row.storedCost ?? row.stored_cost);

  if (isAggregated) {
    if (flatRateAsZero && isFlatRateProvider(provider)) return 0;
    // New rollups preserve the exact API-equivalent value calculated before
    // cache/reasoning token dimensions are discarded. Legacy zero-cost rows
    // fall through to the best available input/output-token estimate.
    if (storedCost > 0) return storedCost;
  }

  const pricing = resolveModelPricing(
    pricingByProvider,
    providerAliasMap,
    provider,
    model,
    normalizeModelName
  );
  if (!pricing) return 0;

  return computeCostFromPricing(
    pricing,
    {
      input: toNumber(row.promptTokens),
      output: toNumber(row.completionTokens),
      cacheRead: toNumber(row.cacheReadTokens),
      cacheCreation: toNumber(row.cacheCreationTokens),
      reasoning: toNumber(row.reasoningTokens),
    },
    {
      provider,
      model,
      serviceTier,
      flatRateAsZero,
    }
  );
}

function hasUsageRowPricing(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  normalizeModelName: (model: string) => string,
  flatRateAsZero = true
): boolean {
  const provider = toStringValue(row.provider);
  const model = toStringValue(row.model);
  if (!provider || !model) return false;
  const isAggregated = toNumber(row.isAggregated ?? row.is_aggregated) > 0;
  if (isAggregated && toNumber(row.storedCost ?? row.stored_cost) > 0) return true;
  if (flatRateAsZero && isFlatRateProvider(provider)) return false;
  return Boolean(
    resolveModelPricing(pricingByProvider, providerAliasMap, provider, model, normalizeModelName)
  );
}

function computeUsageRowStandardCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  normalizeModelName: (model: string) => string,
  computeCostFromPricing: ComputeCostFromPricing,
  flatRateAsZero = true
): number {
  return computeUsageRowCost(
    {
      ...row,
      serviceTier: "standard",
      service_tier: "standard",
      storedCost: 0,
      stored_cost: 0,
      isAggregated: 0,
      is_aggregated: 0,
    },
    pricingByProvider,
    providerAliasMap,
    normalizeModelName,
    computeCostFromPricing,
    flatRateAsZero
  );
}

function computeUsageSavingsTokens(
  row: Record<string, unknown>,
  serviceTier: string,
  getCodexFastCostMultiplier: GetCodexFastCostMultiplier
): number {
  const provider = toStringValue(row.provider);
  const model = toStringValue(row.model);
  const totalTokens = toNumber(row.totalTokens);
  if (!provider || !model || totalTokens <= 0) return 0;

  const standardMultiplier = getCodexFastCostMultiplier(provider, model, "standard");
  if (standardMultiplier <= 0) return 0;

  const actualMultiplier = getCodexFastCostMultiplier(provider, model, serviceTier);
  const savingsRatio = Math.max(0, (standardMultiplier - actualMultiplier) / standardMultiplier);
  return totalTokens * savingsRatio;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeActivityStreak(activityMap: Record<string, number>): number {
  const cursor = new Date();
  let streak = 0;

  while ((activityMap[formatUtcDate(cursor)] || 0) > 0) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streak;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const apiKeyIdsParam = searchParams.get("apiKeyIds") || "";
    const apiKeyIds = apiKeyIdsParam ? apiKeyIdsParam.split(",").filter(Boolean) : [];
    const providerFilter = searchParams.get("provider")?.trim() || "";
    const modelFilter = searchParams.get("model")?.trim() || "";
    // Flat-rate subscriptions are $0 in billed-cost analytics by default. The
    // dedicated costs page opts into their token-price equivalent so subscription
    // consumption can be compared with metered providers without changing budgets.
    const includeFlatRateEstimates = searchParams.get("includeFlatRateEstimates") === "true";

    const sinceIso = startDate || getRangeStartIso(range);
    const untilIso = endDate || null;
    const presetsParam = searchParams.get("presets");

    const apiKeys = await getApiKeys();
    const currentApiKeyNames = new Map<string, string>();
    for (const apiKey of apiKeys) {
      if (typeof apiKey.id === "string" && typeof apiKey.name === "string") {
        currentApiKeyNames.set(apiKey.id, apiKey.name);
      }
    }

    // Raw-data cutoff: must match cleanupUsageHistory's rollup/delete boundary —
    // retention.usageHistory (src/lib/db/cleanup.ts), NOT aggregation.rawDataRetentionDays.
    const dbSettings = getUserDatabaseSettings();
    const rawRetentionDays = dbSettings.retention?.usageHistory ?? 30;
    const rawCutoff = new Date();
    rawCutoff.setDate(rawCutoff.getDate() - rawRetentionDays);
    const rawCutoffIso = rawCutoff.toISOString();

    const conditions = [];
    const params: Record<string, string> = {};

    if (sinceIso) {
      conditions.push("timestamp >= @since");
      params.since = sinceIso;
    }
    if (untilIso) {
      conditions.push("timestamp <= @until");
      params.until = untilIso;
    }

    let apiKeyWhere = "";
    const unifiedFilters: string[] = [];
    if (apiKeyIds.length > 0) {
      const placeholders = apiKeyIds.map((_, i) => `@apiKey${i}`);
      apiKeyIds.forEach((key, i) => {
        params[`apiKey${i}`] = key;
      });
      unifiedFilters.push(
        `(api_key_name IN (${placeholders.join(",")}) OR api_key_id IN (${placeholders.join(",")}))`
      );
      conditions.push(unifiedFilters[unifiedFilters.length - 1]);
    }
    if (providerFilter) {
      params.providerFilter = `%${providerFilter}%`;
      unifiedFilters.push("LOWER(provider) LIKE LOWER(@providerFilter)");
      conditions.push("LOWER(provider) LIKE LOWER(@providerFilter)");
    }
    if (modelFilter) {
      params.modelFilter = `%${modelFilter}%`;
      unifiedFilters.push("LOWER(model) LIKE LOWER(@modelFilter)");
      conditions.push("LOWER(model) LIKE LOWER(@modelFilter)");
    }
    apiKeyWhere = unifiedFilters.join(" AND ");

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Build the UNION data source that merges recent raw rows with older aggregated history.
    // SQL is encapsulated in usageAnalytics.ts — the route only supplies filter parameters.
    const rawCutoffDate = rawCutoffIso.split("T")[0];
    const apiKeyParamEntries: Record<string, string> = {};
    apiKeyIds.forEach((key, i) => {
      apiKeyParamEntries[`apiKey${i}`] = key;
    });
    if (providerFilter) apiKeyParamEntries.providerFilter = `%${providerFilter}%`;
    if (modelFilter) apiKeyParamEntries.modelFilter = `%${modelFilter}%`;

    const { unifiedSource, unifiedParams } = buildUnifiedSource({
      sinceIso: sinceIso ?? null,
      untilIso: untilIso ?? null,
      rawCutoffDate,
      apiKeyWhere,
      apiKeyParams: apiKeyParamEntries,
    });

    // Fetch pricing data for cost calculation (no rows loaded)
    const { getPricing } = await import("@/lib/db/settings");
    const rawPricingByProvider = (await getPricing()) as PricingByProvider;

    // Pre-process pricing data to lowercase keys for O(1) lookups
    const pricingByProvider: PricingByProvider = {};
    for (const [providerKey, providerVal] of Object.entries(rawPricingByProvider || {})) {
      const lowerProvider = {};
      for (const [modelKey, modelVal] of Object.entries(providerVal || {})) {
        (lowerProvider as any)[modelKey.toLowerCase()] = modelVal;
      }
      pricingByProvider[providerKey.toLowerCase()] = lowerProvider;
    }
    const { computeCostFromPricing, getCodexFastCostMultiplier, normalizeModelName } =
      await import("@/lib/usage/costCalculator");
    const { PROVIDER_ID_TO_ALIAS } = await import("@omniroute/open-sse/config/providerModels");

    const summaryRow = getUsageSummary(unifiedSource, unifiedParams) as Record<string, unknown>;

    const dailyRows = getDailyUsage(unifiedSource, unifiedParams) as UsageRows;
    const dailyCostRows = getDailyCostRows(unifiedSource, unifiedParams) as UsageRows;

    const heatmapStart = new Date();
    heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
    // Custom date range might need a wider heatmap window
    if (startDate) {
      const customStart = new Date(startDate);
      if (customStart.getTime() < heatmapStart.getTime()) {
        heatmapStart.setTime(customStart.getTime());
      }
    }

    // Heatmap needs its own whereClause if api keys are filtered
    const heatmapConditions = ["timestamp >= @heatmapStart"];
    if (apiKeyWhere) heatmapConditions.push(apiKeyWhere);
    const heatmapParams: Record<string, string> = { heatmapStart: heatmapStart.toISOString() };
    if (apiKeyIds.length > 0) {
      apiKeyIds.forEach((key, i) => {
        heatmapParams[`apiKey${i}`] = key;
      });
    }
    if (providerFilter) heatmapParams.providerFilter = `%${providerFilter}%`;
    if (modelFilter) heatmapParams.modelFilter = `%${modelFilter}%`;

    const heatmapRows = getHeatmapRows(heatmapConditions, heatmapParams) as UsageRows;

    const modelRows = getModelUsageRows(unifiedSource, unifiedParams) as UsageRows;

    const providerCostRows = getProviderCostRows(unifiedSource, unifiedParams) as UsageRows;

    const providerRows = getProviderUsageRows(unifiedSource, unifiedParams) as UsageRows;

    const accountCostWhereClause = whereClause
      .replace(/timestamp/g, "usage_history.timestamp")
      .replace(/api_key_/g, "usage_history.api_key_");
    const accountCostRows = getAccountCostRows(accountCostWhereClause, params) as UsageRows;

    const accountRows = getAccountUsageRows(accountCostWhereClause, params) as UsageRows;

    const apiKeyWhereClause = appendWhereCondition(
      whereClause,
      "(api_key_id IS NOT NULL AND api_key_id != '') OR (api_key_name IS NOT NULL AND api_key_name != '')"
    );
    const apiKeyRows = getApiKeyUsageRows(apiKeyWhereClause, params) as UsageRows;

    const serviceTierRows = getServiceTierUsageRows(unifiedSource, unifiedParams) as UsageRows;

    const apiKeyMetadataRows = getApiKeyMetadataRows(apiKeyWhereClause, params) as UsageRows;

    const apiKeyMetadata = new Map<string, { latestName: string; aliases: Set<string> }>();
    for (const row of apiKeyMetadataRows) {
      const apiKeyId = toStringValue(row.apiKeyId);
      const apiKeyGroupKey = toStringValue(row.apiKeyGroupKey, "unknown");
      const groupKey = makeApiKeyUsageGroup(apiKeyId, apiKeyGroupKey);
      const existing = apiKeyMetadata.get(groupKey) || {
        latestName: "",
        aliases: new Set<string>(),
      };
      const apiKeyName = toStringValue(row.apiKeyName);
      if (!existing.latestName && apiKeyName) existing.latestName = apiKeyName;
      addApiKeyAlias(existing.aliases, apiKeyName);
      apiKeyMetadata.set(groupKey, existing);
    }

    const weeklyRows = getWeeklyPatternRows(unifiedSource, unifiedParams) as UsageRows;

    const fallbackRow = getFallbackStats(whereClause, params) as Record<string, unknown>;
    const errorBreakdown = getErrorTypeBreakdown(whereClause, params);

    const summary = {
      totalRequests: Number(summaryRow?.totalRequests || 0),
      promptTokens: Number(summaryRow?.promptTokens || 0),
      completionTokens: Number(summaryRow?.completionTokens || 0),
      totalTokens: Number(summaryRow?.totalTokens || 0),
      uniqueModels: Number(summaryRow?.uniqueModels || 0),
      uniqueAccounts: Number(summaryRow?.uniqueAccounts || 0),
      uniqueApiKeys: Number(summaryRow?.uniqueApiKeys || 0),
      successfulRequests: Number(summaryRow?.successfulRequests || 0),
      successRatePct:
        Number(summaryRow?.totalRequests || 0) > 0
          ? Number(
              (
                (Number(summaryRow?.successfulRequests || 0) /
                  Number(summaryRow?.totalRequests || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      avgLatencyMs: Math.round(Number(summaryRow?.avgLatencyMs || 0)),
      totalCost: null as number | null,
      costKnown: true,
      firstRequest: summaryRow?.firstRequest || "",
      lastRequest: summaryRow?.lastRequest || "",
      fallbackCount: Number(fallbackRow?.fallbacks || 0),
      fastRequests: 0,
      standardRequests: 0,
      flexRequests: 0,
      fastCost: 0,
      standardCost: 0,
      flexCost: 0,
      flexSavings: 0,
      flexUsageSavingsTokens: 0,
      fastRequestSharePct: 0,
      fallbackRatePct:
        Number(fallbackRow?.fallback_eligible || 0) > 0
          ? Number(
              (
                (Number(fallbackRow?.fallbacks || 0) /
                  Number(fallbackRow?.fallback_eligible || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      requestedModelCoveragePct:
        Number(fallbackRow?.total || 0) > 0
          ? Number(
              (
                (Number(fallbackRow?.with_requested || 0) / Number(fallbackRow?.total || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      streak: 0,
    };

    const dailyByModelMap: Record<string, Record<string, number>> = {};
    const allModels = new Set<string>();

    const dailyCostByDate = new Map<string, number>();
    const dailyCostUnknownDates = new Set<string>();
    for (const row of dailyCostRows) {
      const date = toStringValue(row.date);
      if (!date) continue;

      // Calculate costs
      const cost = computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      dailyCostByDate.set(date, (dailyCostByDate.get(date) || 0) + cost);
      if (
        !hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        )
      ) {
        dailyCostUnknownDates.add(date);
        summary.costKnown = false;
      }

      // Group tokens by model for the day
      const model = normalizeModelName(row.model as string);
      const tokens = Number(row.promptTokens) + Number(row.completionTokens);

      if (!dailyByModelMap[date]) dailyByModelMap[date] = {};
      dailyByModelMap[date][model] = (dailyByModelMap[date][model] || 0) + tokens;
      allModels.add(model);
    }

    const dailyTrend = dailyRows.map((row) => ({
      date: row.date,
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens),
      cost: dailyCostUnknownDates.has(toStringValue(row.date))
        ? null
        : roundCost(dailyCostByDate.get(toStringValue(row.date)) || 0),
    }));

    const activityMap: Record<string, number> = {};
    for (const row of heatmapRows) {
      activityMap[row.date as string] = Number(row.totalTokens);
    }
    summary.streak = computeActivityStreak(activityMap);

    const modelMap = new Map<string, Record<string, unknown>>();
    for (const row of modelRows) {
      const model = row.model as string;
      const provider = row.provider as string;
      const short = normalizeModelName(model);
      const cost = computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      // Keyed by model name alone (not provider) — the table renders one row per
      // model, so the same model served via multiple provider connections/accounts
      // must be merged here rather than producing duplicate `key={m.model}` rows.
      const key = short;
      const existing = modelMap.get(key) || {
        model: short,
        provider,
        rawModel: model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyWeightedTotal: 0,
        successfulRequests: 0,
        lastUsed: "",
        cost: 0,
        costKnown: true,
      };
      const requests = Number(row.requests) || 0;
      existing.requests = Number(existing.requests || 0) + requests;
      existing.promptTokens = Number(existing.promptTokens || 0) + Number(row.promptTokens || 0);
      existing.completionTokens =
        Number(existing.completionTokens || 0) + Number(row.completionTokens || 0);
      existing.totalTokens = Number(existing.totalTokens || 0) + Number(row.totalTokens || 0);
      existing.latencyWeightedTotal =
        Number(existing.latencyWeightedTotal || 0) + Number(row.avgLatencyMs || 0) * requests;
      existing.successfulRequests =
        Number(existing.successfulRequests || 0) + Number(row.successfulRequests || 0);
      if (!existing.lastUsed || String(row.lastUsed || "") > String(existing.lastUsed || "")) {
        existing.lastUsed = row.lastUsed;
      }
      existing.cost = Number(existing.cost || 0) + cost;
      existing.costKnown =
        Boolean(existing.costKnown) &&
        hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        );
      modelMap.set(key, existing);
    }

    const byModel = Array.from(modelMap.values())
      .map((row) => ({
        model: row.model,
        provider: row.provider,
        rawModel: row.rawModel,
        requests: Number(row.requests),
        promptTokens: Number(row.promptTokens),
        completionTokens: Number(row.completionTokens),
        totalTokens: Number(row.totalTokens),
        avgLatencyMs:
          Number(row.requests) > 0
            ? Math.round(Number(row.latencyWeightedTotal || 0) / Number(row.requests))
            : 0,
        successRatePct:
          Number(row.requests) > 0
            ? Number((Number(row.successfulRequests || 0) / Number(row.requests)) * 100).toFixed(2)
            : 0,
        lastUsed: row.lastUsed,
        cost: row.costKnown ? roundCost(Number(row.cost || 0)) : null,
        costKnown: Boolean(row.costKnown),
      }))
      .sort((left, right) => Number(right.requests) - Number(left.requests))
      .slice(0, 50);

    const totalCost = Array.from(dailyCostByDate.values()).reduce((sum, cost) => sum + cost, 0);
    summary.totalCost = summary.costKnown ? roundCost(totalCost) : null;

    const providerCostByProvider = new Map<string, number>();
    const providerCostUnknown = new Set<string>();
    for (const row of providerCostRows) {
      const provider = toStringValue(row.provider);
      if (!provider) continue;
      const cost = computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      providerCostByProvider.set(provider, (providerCostByProvider.get(provider) || 0) + cost);
      if (
        !hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        )
      ) {
        providerCostUnknown.add(provider);
      }
    }

    const byProvider = await buildByProviderRows(
      providerRows,
      providerCostByProvider,
      providerCostUnknown
    );

    const accountCostByAccount = new Map<string, number>();
    const accountCostUnknown = new Set<string>();
    for (const row of accountCostRows) {
      const accountKey = toStringValue(row.accountKey, "unknown");
      const cost = computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      accountCostByAccount.set(accountKey, (accountCostByAccount.get(accountKey) || 0) + cost);
      if (
        !hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        )
      ) {
        accountCostUnknown.add(accountKey);
      }
    }

    const byAccount = accountRows.map((row) => ({
      account: toStringValue(row.account, "unknown"),
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens),
      avgLatencyMs: Math.round(Number(row.avgLatencyMs)),
      lastUsed: row.lastUsed,
      cost: accountCostUnknown.has(toStringValue(row.accountKey, "unknown"))
        ? null
        : roundCost(accountCostByAccount.get(toStringValue(row.accountKey, "unknown")) || 0),
      costKnown: !accountCostUnknown.has(toStringValue(row.accountKey, "unknown")),
    }));

    const apiKeyMap = new Map<
      string,
      {
        apiKey: string;
        apiKeyId: string | null;
        apiKeyName: string;
        historicalApiKeyNames: string[];
        requests: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
        costKnown: boolean;
      }
    >();
    for (const row of apiKeyRows) {
      const apiKeyId = toStringValue(row.apiKeyId);
      const apiKeyGroupKey = toStringValue(row.apiKeyGroupKey, "unknown");
      const key = makeApiKeyUsageGroup(apiKeyId, apiKeyGroupKey);
      const metadata = apiKeyMetadata.get(key);
      const apiKeyName =
        (apiKeyId ? currentApiKeyNames.get(apiKeyId) : undefined) ||
        metadata?.latestName ||
        apiKeyId ||
        apiKeyGroupKey ||
        "Unknown API key";
      const existing = apiKeyMap.get(key) || {
        apiKey: apiKeyId && apiKeyName !== apiKeyId ? `${apiKeyName} (${apiKeyId})` : apiKeyName,
        apiKeyId: apiKeyId || null,
        apiKeyName,
        historicalApiKeyNames: Array.from(metadata?.aliases || []),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        costKnown: true,
      };

      existing.requests += Number(row.requests);
      existing.promptTokens += Number(row.promptTokens);
      existing.completionTokens += Number(row.completionTokens);
      existing.totalTokens += Number(row.totalTokens);
      existing.cost += computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      existing.costKnown =
        Boolean(existing.costKnown) &&
        hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        );
      apiKeyMap.set(key, existing);
    }
    const byApiKey = Array.from(apiKeyMap.values())
      .map((row) => ({ ...row, cost: row.costKnown ? roundCost(row.cost) : null }))
      .sort((left, right) => Number(right.cost || 0) - Number(left.cost || 0));

    const serviceTierMap = new Map<
      string,
      {
        serviceTier: "standard" | "priority" | "flex";
        label: string;
        requests: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
        costKnown: boolean;
        savings: number;
        usageSavingsTokens: number;
      }
    >();
    for (const row of serviceTierRows) {
      const serviceTier = normalizeServiceTier(row.serviceTier);
      const existing = serviceTierMap.get(serviceTier) || {
        serviceTier,
        label: getServiceTierLabelId(serviceTier),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        costKnown: true,
        savings: 0,
        usageSavingsTokens: 0,
      };
      existing.requests += Number(row.requests || 0);
      existing.promptTokens += Number(row.promptTokens || 0);
      existing.completionTokens += Number(row.completionTokens || 0);
      existing.totalTokens += Number(row.totalTokens || 0);
      const actualCost = computeUsageRowCost(
        row,
        pricingByProvider,
        PROVIDER_ID_TO_ALIAS,
        normalizeModelName,
        computeCostFromPricing,
        !includeFlatRateEstimates
      );
      existing.cost += actualCost;
      existing.costKnown =
        Boolean(existing.costKnown) &&
        hasUsageRowPricing(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          !includeFlatRateEstimates
        );
      if (serviceTier === "flex") {
        const standardCost = computeUsageRowStandardCost(
          row,
          pricingByProvider,
          PROVIDER_ID_TO_ALIAS,
          normalizeModelName,
          computeCostFromPricing,
          !includeFlatRateEstimates
        );
        existing.savings += Math.max(0, standardCost - actualCost);
        existing.usageSavingsTokens += computeUsageSavingsTokens(
          row,
          serviceTier,
          getCodexFastCostMultiplier
        );
      }
      serviceTierMap.set(serviceTier, existing);
    }
    const byServiceTier = Array.from(serviceTierMap.values())
      .map((row) => ({
        ...row,
        cost: row.costKnown ? roundCost(row.cost) : null,
        costKnown: row.costKnown,
        savings: row.costKnown ? roundCost(row.savings) : null,
        usageSavingsTokens: Math.round(row.usageSavingsTokens),
      }))
      .sort((left, right) => {
        const order = { priority: 0, flex: 1, standard: 2 } as const;
        return order[left.serviceTier] - order[right.serviceTier];
      });
    const fastTier = serviceTierMap.get("priority");
    const flexTier = serviceTierMap.get("flex");
    const standardTier = serviceTierMap.get("standard");
    summary.fastRequests = fastTier?.requests || 0;
    summary.fastCost = roundCost(fastTier?.cost || 0);
    summary.flexRequests = flexTier?.requests || 0;
    summary.flexCost = roundCost(flexTier?.cost || 0);
    summary.flexSavings = roundCost(flexTier?.savings || 0);
    summary.flexUsageSavingsTokens = Math.round(flexTier?.usageSavingsTokens || 0);
    summary.standardRequests = standardTier?.requests || 0;
    summary.standardCost = roundCost(standardTier?.cost || 0);
    summary.fastRequestSharePct =
      summary.totalRequests > 0
        ? Number(((Number(summary.fastRequests) / Number(summary.totalRequests)) * 100).toFixed(2))
        : 0;

    const weeklyTokens = [0, 0, 0, 0, 0, 0, 0];
    const weeklyCounts = [0, 0, 0, 0, 0, 0, 0];
    const weeklyPattern = WEEKDAY_LABELS.map((day) => ({
      day,
      avgTokens: 0,
      totalTokens: 0,
    }));
    for (const row of weeklyRows) {
      const dayIdx = Number(row.dayOfWeek);
      if (dayIdx >= 0 && dayIdx <= 6) {
        const totalTokens = Number(row.totalTokens);
        const days = Number(row.days);
        weeklyTokens[dayIdx] = totalTokens;
        weeklyCounts[dayIdx] = Number(row.requests);
        weeklyPattern[dayIdx] = {
          day: WEEKDAY_LABELS[dayIdx],
          avgTokens: days > 0 ? Math.round(totalTokens / days) : 0,
          totalTokens,
        };
      }
    }

    const dailyByModel = Object.keys(dailyByModelMap)
      .sort()
      .map((date) => ({ date, ...dailyByModelMap[date] }));
    const modelNames = Array.from(allModels);
    const tokenUsageFilter = {
      sinceIso: sinceIso ?? null,
      untilIso,
      apiKeyIds,
      provider: providerFilter,
      model: modelFilter,
      rawCutoffDate,
    };
    const tokenSources = getTokenUsageSourceRows(tokenUsageFilter).map((row) => {
      const lastUpdate = String(row.lastUpdate || "");
      const ageMs = lastUpdate ? Date.now() - new Date(lastUpdate).getTime() : Infinity;
      return {
        ...row,
        status: Number.isFinite(ageMs) && ageMs <= 24 * 60 * 60 * 1000 ? "recent" : "stale",
      };
    });
    const monthlyTokenUsage = getTokenUsageMonthlyRows(tokenUsageFilter);
    const dailyTokenUsage = getTokenUsageDailyRows(tokenUsageFilter);
    const tokenUsageByProvider = getTokenUsageBreakdownRows(tokenUsageFilter, "provider");
    const tokenUsageByModel = getTokenUsageBreakdownRows(tokenUsageFilter, "model");
    const usageConnections = getUsageConnectionStatusRows().map((row) => {
      const provider = String(row.provider || "");
      const authType = String(row.authType || "").toLowerCase();
      const sourceKind = isLocalProvider(provider)
        ? "local"
        : isFlatRateProvider(provider) ||
            ((provider === "codex" || provider === "cx") && authType === "oauth")
          ? "subscription"
          : "cloud-api";
      const lastUpdate =
        [row.lastUsageAt, row.lastTested, row.lastUsedAt]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .sort((left, right) => right.localeCompare(left))[0] || null;
      return {
        provider,
        connectionName: row.connectionName || null,
        sourceKind,
        state:
          Number(row.isActive) !== 1
            ? "disabled"
            : row.testStatus
              ? String(row.testStatus)
              : row.lastUsageAt
                ? "capturing usage"
                : "configured; no usage event yet",
        lastUpdate,
        lastUsageAt: row.lastUsageAt || null,
      };
    });

    const analytics = {
      summary,
      dailyTrend,
      activityMap,
      byModel,
      byProvider,
      byApiKey,
      byAccount,
      byServiceTier,
      weeklyPattern,
      weeklyTokens,
      weeklyCounts,
      dailyByModel,
      modelNames,
      errorBreakdown,
      range,
      includesFlatRateEstimates: includeFlatRateEstimates,
      tokenSources,
      dailyTokenUsage,
      monthlyTokenUsage,
      tokenUsageByProvider,
      tokenUsageByModel,
      usageConnections,
    } as any;

    if (presetsParam) {
      const allowedRanges = new Set(["1d", "7d", "30d", "90d", "ytd", "all"]);
      const presetRanges = presetsParam
        .split(",")
        .map((preset) => preset.trim())
        .filter((preset) => allowedRanges.has(preset));
      const presetSummaries: Record<string, { totalCost: number | null; costKnown: boolean }> = {};

      for (const presetRange of presetRanges) {
        if (presetRange === range) {
          presetSummaries[presetRange] = {
            totalCost: analytics.summary?.costKnown
              ? Number(analytics.summary?.totalCost || 0)
              : null,
            costKnown: analytics.summary?.costKnown !== false,
          };
          continue;
        }

        const presetSinceIso = getRangeStartIso(presetRange);
        const { unifiedSource: pSrc, unifiedParams: pParams } = buildPresetUnifiedSource({
          sinceIso: presetSinceIso ?? null,
          untilIso: null,
          rawCutoffDate,
          apiKeyWhere,
          apiKeyParams: apiKeyParamEntries,
        });

        const presetModelRows = getPresetCostModelRows(pSrc, pParams) as UsageRows;

        let presetTotalCost = 0;
        let presetCostKnown = true;
        for (const row of presetModelRows) {
          presetTotalCost += computeUsageRowCost(
            row,
            pricingByProvider,
            PROVIDER_ID_TO_ALIAS,
            normalizeModelName,
            computeCostFromPricing,
            !includeFlatRateEstimates
          );
          if (
            !hasUsageRowPricing(
              row,
              pricingByProvider,
              PROVIDER_ID_TO_ALIAS,
              normalizeModelName,
              !includeFlatRateEstimates
            )
          ) {
            presetCostKnown = false;
          }
        }

        presetSummaries[presetRange] = {
          totalCost: presetCostKnown ? roundCost(presetTotalCost) : null,
          costKnown: presetCostKnown,
        };
      }

      analytics.presetSummaries = presetSummaries;
    }

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error computing analytics:", error);
    // Surface the real (sanitized) reason so the dashboard can show it instead of a
    // generic placeholder (#3356). buildErrorBody strips stacks/absolute paths.
    const { buildErrorBody } = await import("@omniroute/open-sse/utils/error");
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(buildErrorBody(500, message || "Failed to compute analytics"), {
      status: 500,
    });
  }
}

function nullableTokenCount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Import only a normalized list of usage metadata; raw prompts are never accepted. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const bodyText = await request.text();
    if (bodyText.length > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Usage import exceeds the 10 MB limit." }, { status: 413 });
    }
    const parsed: unknown = JSON.parse(bodyText);
    const events = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as { events?: unknown }).events
        : null;
    if (!Array.isArray(events) || events.length > 5000) {
      return NextResponse.json(
        { error: "Provide an events array containing at most 5,000 normalized records." },
        { status: 400 }
      );
    }

    let imported = 0;
    let skipped = 0;
    for (const [eventIndex, value] of events.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        skipped++;
        continue;
      }
      const event = value as Record<string, unknown>;
      const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
      const provider = typeof event.provider === "string" ? event.provider.trim() : "";
      const model = typeof event.model === "string" ? event.model.trim() : "";
      const timestampMs = Date.parse(timestamp);
      if (
        !provider ||
        provider.length > 120 ||
        !model ||
        model.length > 240 ||
        !timestamp ||
        !Number.isFinite(timestampMs)
      ) {
        skipped++;
        continue;
      }

      const tokenFields = [
        "promptTokens",
        "completionTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "reasoningTokens",
        "noCacheTokens",
      ];
      const tokens: Record<string, number> = {};
      let invalid = false;
      const fieldMap: Record<string, string> = {
        promptTokens: "prompt_tokens",
        completionTokens: "completion_tokens",
        cacheReadTokens: "cached_tokens",
        cacheCreationTokens: "cache_creation_input_tokens",
        reasoningTokens: "reasoning_tokens",
        noCacheTokens: "no_cache_tokens",
      };
      for (const field of tokenFields) {
        if (event[field] === undefined || event[field] === null || event[field] === "") continue;
        const count = nullableTokenCount(event[field]);
        if (count === null) {
          invalid = true;
          break;
        }
        const key = fieldMap[field];
        tokens[key] = count;
      }
      if (invalid) {
        skipped++;
        continue;
      }
      const sourceReportedInput =
        event.sourceReportedInput === undefined || event.sourceReportedInput === null
          ? null
          : nullableTokenCount(event.sourceReportedInput);
      if (event.sourceReportedInput != null && sourceReportedInput === null) {
        skipped++;
        continue;
      }

      const validStatuses = new Set(["reported", "estimated", "unavailable", "legacy_unknown"]);
      const inputStatus = String(
        event.inputStatus || (tokens.prompt_tokens === undefined ? "unavailable" : "")
      );
      const outputStatus = String(
        event.outputStatus || (tokens.completion_tokens === undefined ? "unavailable" : "")
      );
      if (
        !validStatuses.has(inputStatus) ||
        !validStatuses.has(outputStatus) ||
        (inputStatus === "unavailable" && tokens.prompt_tokens !== undefined) ||
        (outputStatus === "unavailable" && tokens.completion_tokens !== undefined) ||
        (["reported", "estimated"].includes(inputStatus) && tokens.prompt_tokens === undefined) ||
        (["reported", "estimated"].includes(outputStatus) && tokens.completion_tokens === undefined)
      ) {
        skipped++;
        continue;
      }
      const allowedKinds = new Set(["local", "cloud-api", "subscription", "imported", "unknown"]);
      const sourceKind = String(event.sourceKind || "unknown");
      if (!allowedKinds.has(sourceKind)) {
        skipped++;
        continue;
      }
      const sourceLabel =
        typeof event.sourceLabel === "string" ? event.sourceLabel.slice(0, 240) : "";
      const externalEventId =
        (typeof event.eventId === "string" || typeof event.eventId === "number") &&
        String(event.eventId).length <= 1024
          ? String(event.eventId)
          : null;
      const importEventId = createHash("sha256")
        .update(
          JSON.stringify(
            externalEventId
              ? ["source-event", provider, model, sourceLabel, timestamp, externalEventId]
              : [
                  "source-row",
                  eventIndex,
                  timestamp,
                  provider,
                  model,
                  sourceKind,
                  sourceLabel,
                  inputStatus,
                  outputStatus,
                  tokens,
                ]
          )
        )
        .digest("hex");
      const categoryStatuses = [
        ["cacheReadStatus", "cacheReadTokens"],
        ["cacheCreationStatus", "cacheCreationTokens"],
        ["reasoningStatus", "reasoningTokens"],
        ["noCacheStatus", "noCacheTokens"],
      ] as const;
      let invalidCategoryStatus = false;
      const validCategoryStatuses = new Set(["reported", "unavailable", "legacy_unknown"]);
      for (const [statusKey, tokenKey] of categoryStatuses) {
        const statusValue = event[statusKey];
        const tokenValue = event[tokenKey];
        if (
          (tokenValue !== undefined && tokenValue !== null && !statusValue) ||
          (statusValue !== undefined && !validCategoryStatuses.has(String(statusValue))) ||
          (statusValue === "unavailable" && tokens[fieldMap[tokenKey]] !== undefined) ||
          (statusValue === "reported" && tokens[fieldMap[tokenKey]] === undefined)
        ) {
          invalidCategoryStatus = true;
          break;
        }
      }
      if (invalidCategoryStatus) {
        skipped++;
        continue;
      }
      const saved = await saveRequestUsage({
        provider,
        model,
        timestamp: new Date(timestampMs).toISOString(),
        tokens,
        inputStatus: inputStatus as "reported" | "estimated" | "unavailable" | "legacy_unknown",
        outputStatus: outputStatus as "reported" | "estimated" | "unavailable" | "legacy_unknown",
        cacheReadStatus: event.cacheReadStatus as
          "reported" | "unavailable" | "legacy_unknown" | undefined,
        cacheCreationStatus: event.cacheCreationStatus as
          "reported" | "unavailable" | "legacy_unknown" | undefined,
        reasoningStatus: event.reasoningStatus as
          "reported" | "unavailable" | "legacy_unknown" | undefined,
        noCacheStatus: event.noCacheStatus as
          "reported" | "unavailable" | "legacy_unknown" | undefined,
        sourceReportedInput,
        sourceKind: sourceKind as "local" | "cloud-api" | "subscription" | "imported" | "unknown",
        sourceLabel: sourceLabel
          ? `Imported JSON; prior source: ${sourceLabel}`
          : "User-selected normalized JSON import",
        importEventId,
        ingestion: "import",
        success: true,
      });
      if (saved) imported++;
      else skipped++;
    }
    return NextResponse.json({ imported, skipped });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid usage import file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
