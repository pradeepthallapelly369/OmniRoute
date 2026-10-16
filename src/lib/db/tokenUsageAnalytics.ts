/** Provenance-aware token totals for the desktop usage dashboard. */

import { getDbInstance } from "./core";

export type TokenUsageFilter = {
  sinceIso?: string | null;
  untilIso?: string | null;
  apiKeyIds?: string[];
  provider?: string;
  model?: string;
  rawCutoffDate?: string;
};

function makeFilters(filter: TokenUsageFilter) {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.sinceIso) {
    where.push("timestamp >= @since");
    params.since = filter.sinceIso;
  }
  if (filter.untilIso) {
    where.push("timestamp <= @until");
    params.until = filter.untilIso;
  }
  for (const [index, id] of (filter.apiKeyIds || []).entries()) {
    params[`apiKey${index}`] = id;
  }
  if (filter.apiKeyIds?.length) {
    const keys = filter.apiKeyIds.map((_, index) => `@apiKey${index}`).join(", ");
    where.push(`(api_key_id IN (${keys}) OR api_key_name IN (${keys}))`);
  }
  if (filter.provider?.trim()) {
    where.push("LOWER(provider) LIKE LOWER(@providerFilter)");
    params.providerFilter = `%${filter.provider.trim()}%`;
  }
  if (filter.model?.trim()) {
    where.push("LOWER(model) LIKE LOWER(@modelFilter)");
    params.modelFilter = `%${filter.model.trim()}%`;
  }
  return { where, params };
}

function makeLegacyFilters(filter: TokenUsageFilter) {
  const where: string[] = [];
  const params: Record<string, string> = {};
  const sinceDate = filter.sinceIso?.slice(0, 10);
  const cutoff = filter.rawCutoffDate;
  if (sinceDate && cutoff && sinceDate >= cutoff) return null;
  if (sinceDate) {
    where.push("date >= @legacySince");
    params.legacySince = sinceDate;
  }
  if (filter.untilIso) {
    where.push("date <= @legacyUntil");
    params.legacyUntil = filter.untilIso.slice(0, 10);
  }
  if (cutoff) {
    where.push("date < @legacyCutoff");
    params.legacyCutoff = cutoff;
  }
  if (filter.provider?.trim()) {
    where.push("LOWER(provider) LIKE LOWER(@legacyProviderFilter)");
    params.legacyProviderFilter = `%${filter.provider.trim()}%`;
  }
  if (filter.model?.trim()) {
    where.push("LOWER(model) LIKE LOWER(@legacyModelFilter)");
    params.legacyModelFilter = `%${filter.model.trim()}%`;
  }
  return { where, params };
}

/** Group requests and token fields by observed source and ingestion method. */
export function getTokenUsageSourceRows(filter: TokenUsageFilter = {}) {
  const db = getDbInstance();
  const { where, params } = makeFilters(filter);
  const rawWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT usage_source_kind as sourceKind, usage_ingestion as ingestion,
        usage_source_label as sourceLabel, MAX(timestamp) as lastUpdate, COUNT(*) as requests,
        SUM(CASE WHEN usage_input_status = 'reported' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputReported,
        SUM(CASE WHEN usage_input_status = 'estimated' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputEstimated,
        CASE WHEN COUNT(tokens_input_source_reported) > 0
          THEN SUM(tokens_input_source_reported) ELSE NULL END as inputSourceReported,
        SUM(CASE WHEN usage_input_status = 'legacy_unknown' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputLegacyUnknown,
        SUM(CASE WHEN usage_output_status = 'reported' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputReported,
        SUM(CASE WHEN usage_output_status = 'estimated' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputEstimated,
        SUM(CASE WHEN usage_output_status = 'legacy_unknown' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputLegacyUnknown,
        CASE WHEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN COALESCE(tokens_no_cache, 0) ELSE 0 END) ELSE NULL END as noCacheReported,
        SUM(CASE WHEN usage_no_cache_status = 'unavailable' THEN 1 ELSE 0 END) as noCacheUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN COALESCE(tokens_cache_read, 0) ELSE 0 END) ELSE NULL END as cacheReadReported,
        SUM(CASE WHEN usage_cache_read_status = 'unavailable' THEN 1 ELSE 0 END) as cacheReadUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN COALESCE(tokens_cache_creation, 0) ELSE 0 END) ELSE NULL END as cacheCreationReported,
        SUM(CASE WHEN usage_cache_creation_status = 'unavailable' THEN 1 ELSE 0 END) as cacheCreationUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN COALESCE(tokens_reasoning, 0) ELSE 0 END) ELSE NULL END as reasoningReported,
        SUM(CASE WHEN usage_reasoning_status = 'unavailable' THEN 1 ELSE 0 END) as reasoningUnavailableRequests,
        SUM(CASE WHEN usage_input_status = 'unavailable' THEN 1 ELSE 0 END) as inputUnavailableRequests,
        SUM(CASE WHEN usage_output_status = 'unavailable' THEN 1 ELSE 0 END) as outputUnavailableRequests
      FROM usage_history ${rawWhere}
      GROUP BY usage_source_kind, usage_ingestion, usage_source_label
      ORDER BY lastUpdate DESC`
    )
    .all(params) as Array<Record<string, unknown>>;

  const legacyFilters = makeLegacyFilters(filter);
  if (legacyFilters && !filter.apiKeyIds?.length) {
    const legacyWhere = legacyFilters.where.length
      ? `WHERE ${legacyFilters.where.join(" AND ")}`
      : "";
    const legacy = db
      .prepare(
        `SELECT 'unknown' as sourceKind, 'legacy' as ingestion,
          'Rolled-up legacy usage; token provenance unavailable' as sourceLabel,
          MAX(date) || 'T23:59:59.999Z' as lastUpdate,
          SUM(total_requests) as requests, 0 as inputReported, 0 as inputEstimated,
          NULL as inputSourceReported,
          SUM(total_input_tokens) as inputLegacyUnknown, 0 as outputReported,
          0 as outputEstimated, SUM(total_output_tokens) as outputLegacyUnknown,
          NULL as noCacheReported, 0 as noCacheUnavailableRequests,
          NULL as cacheReadReported, 0 as cacheReadUnavailableRequests,
          NULL as cacheCreationReported, 0 as cacheCreationUnavailableRequests,
          NULL as reasoningReported, 0 as reasoningUnavailableRequests,
          0 as inputUnavailableRequests,
          0 as outputUnavailableRequests
        FROM daily_usage_summary ${legacyWhere}`
      )
      .get(legacyFilters.params) as Record<string, unknown> | undefined;
    if (Number(legacy?.requests || 0) > 0) rows.push(legacy!);
  }
  return rows;
}

/** Monthly source/status split; rolled-up history is always labeled unknown. */
export function getTokenUsageMonthlyRows(filter: TokenUsageFilter = {}) {
  const db = getDbInstance();
  const { where, params } = makeFilters(filter);
  const rawWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const raw = db
    .prepare(
      `SELECT SUBSTR(timestamp, 1, 7) as month, usage_source_kind as sourceKind,
        usage_ingestion as ingestion,
        SUM(CASE WHEN usage_input_status = 'reported' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputReported,
        SUM(CASE WHEN usage_input_status = 'estimated' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputEstimated,
        CASE WHEN COUNT(tokens_input_source_reported) > 0
          THEN SUM(tokens_input_source_reported) ELSE NULL END as inputSourceReported,
        SUM(CASE WHEN usage_input_status = 'legacy_unknown' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputLegacyUnknown,
        SUM(CASE WHEN usage_output_status = 'reported' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputReported,
        SUM(CASE WHEN usage_output_status = 'estimated' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputEstimated,
        SUM(CASE WHEN usage_output_status = 'legacy_unknown' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputLegacyUnknown,
        CASE WHEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN COALESCE(tokens_no_cache, 0) ELSE 0 END) ELSE NULL END as noCacheReported,
        SUM(CASE WHEN usage_no_cache_status = 'unavailable' THEN 1 ELSE 0 END) as noCacheUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN COALESCE(tokens_cache_read, 0) ELSE 0 END) ELSE NULL END as cacheReadReported,
        SUM(CASE WHEN usage_cache_read_status = 'unavailable' THEN 1 ELSE 0 END) as cacheReadUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN COALESCE(tokens_cache_creation, 0) ELSE 0 END) ELSE NULL END as cacheCreationReported,
        SUM(CASE WHEN usage_cache_creation_status = 'unavailable' THEN 1 ELSE 0 END) as cacheCreationUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN COALESCE(tokens_reasoning, 0) ELSE 0 END) ELSE NULL END as reasoningReported,
        SUM(CASE WHEN usage_reasoning_status = 'unavailable' THEN 1 ELSE 0 END) as reasoningUnavailableRequests,
        SUM(CASE WHEN usage_input_status = 'unavailable' THEN 1 ELSE 0 END) as inputUnavailableRequests,
        SUM(CASE WHEN usage_output_status = 'unavailable' THEN 1 ELSE 0 END) as outputUnavailableRequests,
        COUNT(*) as requests
      FROM usage_history ${rawWhere}
      GROUP BY SUBSTR(timestamp, 1, 7), usage_source_kind, usage_ingestion`
    )
    .all(params) as Array<Record<string, unknown>>;
  const legacyFilters = makeLegacyFilters(filter);
  if (legacyFilters && !filter.apiKeyIds?.length) {
    const legacyWhere = legacyFilters.where.length
      ? `WHERE ${legacyFilters.where.join(" AND ")}`
      : "";
    const legacy = db
      .prepare(
        `SELECT SUBSTR(date, 1, 7) as month, 'unknown' as sourceKind, 'legacy' as ingestion,
          0 as inputReported, 0 as inputEstimated,
          NULL as inputSourceReported,
          SUM(total_input_tokens) as inputLegacyUnknown, 0 as outputReported,
          0 as outputEstimated, SUM(total_output_tokens) as outputLegacyUnknown,
          NULL as noCacheReported, 0 as noCacheUnavailableRequests,
          NULL as cacheReadReported, 0 as cacheReadUnavailableRequests,
          NULL as cacheCreationReported, 0 as cacheCreationUnavailableRequests,
          NULL as reasoningReported, 0 as reasoningUnavailableRequests,
          0 as inputUnavailableRequests, 0 as outputUnavailableRequests,
          SUM(total_requests) as requests
        FROM daily_usage_summary ${legacyWhere} GROUP BY SUBSTR(date, 1, 7)`
      )
      .all(legacyFilters.params) as Array<Record<string, unknown>>;
    raw.push(...legacy);
  }

  const merged = new Map<string, Record<string, number | string | null>>();
  for (const row of raw) {
    const month = String(row.month || "");
    if (!month) continue;
    const sourceKind = String(row.sourceKind || "unknown");
    const ingestion = String(row.ingestion || "capture");
    const key = `${month}:${sourceKind}:${ingestion}`;
    const target = merged.get(key) || {
      month,
      sourceKind,
      ingestion,
      requests: 0,
      inputReported: 0,
      inputEstimated: 0,
      inputSourceReported: null,
      inputLegacyUnknown: 0,
      outputReported: 0,
      outputEstimated: 0,
      outputLegacyUnknown: 0,
      noCacheReported: null,
      noCacheUnavailableRequests: 0,
      cacheReadReported: null,
      cacheReadUnavailableRequests: 0,
      cacheCreationReported: null,
      cacheCreationUnavailableRequests: 0,
      reasoningReported: null,
      reasoningUnavailableRequests: 0,
      inputUnavailableRequests: 0,
      outputUnavailableRequests: 0,
    };
    for (const key of [
      "requests",
      "inputReported",
      "inputEstimated",
      "inputSourceReported",
      "inputLegacyUnknown",
      "outputReported",
      "outputEstimated",
      "outputLegacyUnknown",
      "noCacheUnavailableRequests",
      "cacheReadUnavailableRequests",
      "cacheCreationUnavailableRequests",
      "reasoningUnavailableRequests",
      "inputUnavailableRequests",
      "outputUnavailableRequests",
    ]) {
      if (
        key === "inputSourceReported" ||
        (key.endsWith("Reported") &&
          [
            "noCacheReported",
            "cacheReadReported",
            "cacheCreationReported",
            "reasoningReported",
          ].includes(key))
      ) {
        if (row[key] != null) {
          target[key] =
            target[key] == null ? Number(row[key]) : Number(target[key]) + Number(row[key]);
        }
        continue;
      }
      target[key] = Number(target[key]) + Number(row[key] || 0);
    }
    merged.set(key, target);
  }
  return Array.from(merged.values()).sort(
    (a, b) =>
      String(a.month).localeCompare(String(b.month)) ||
      String(a.sourceKind).localeCompare(String(b.sourceKind)) ||
      String(a.ingestion).localeCompare(String(b.ingestion))
  );
}

/** Daily input/output totals split by provenance and local/cloud source. */
export function getTokenUsageDailyRows(filter: TokenUsageFilter = {}) {
  const db = getDbInstance();
  const { where, params } = makeFilters(filter);
  const rawWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const raw = db
    .prepare(
      `SELECT SUBSTR(timestamp, 1, 10) as day, usage_source_kind as sourceKind,
        usage_ingestion as ingestion, COUNT(*) as requests,
        SUM(CASE WHEN usage_input_status = 'reported' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputReported,
        SUM(CASE WHEN usage_input_status = 'estimated' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputEstimated,
        SUM(CASE WHEN usage_input_status = 'legacy_unknown' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputLegacyUnknown,
        SUM(CASE WHEN usage_input_status = 'unavailable' THEN 1 ELSE 0 END) as inputUnavailableRequests,
        SUM(CASE WHEN usage_output_status = 'reported' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputReported,
        SUM(CASE WHEN usage_output_status = 'estimated' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputEstimated,
        SUM(CASE WHEN usage_output_status = 'legacy_unknown' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputLegacyUnknown,
        SUM(CASE WHEN usage_output_status = 'unavailable' THEN 1 ELSE 0 END) as outputUnavailableRequests,
        CASE WHEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_read_status = 'reported' THEN COALESCE(tokens_cache_read, 0) ELSE 0 END) ELSE NULL END as cacheReadReported,
        CASE WHEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_cache_creation_status = 'reported' THEN COALESCE(tokens_cache_creation, 0) ELSE 0 END) ELSE NULL END as cacheCreationReported,
        CASE WHEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_reasoning_status = 'reported' THEN COALESCE(tokens_reasoning, 0) ELSE 0 END) ELSE NULL END as reasoningReported,
        CASE WHEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN 1 ELSE 0 END) > 0
          THEN SUM(CASE WHEN usage_no_cache_status = 'reported' THEN COALESCE(tokens_no_cache, 0) ELSE 0 END) ELSE NULL END as noCacheReported
      FROM usage_history ${rawWhere}
      GROUP BY SUBSTR(timestamp, 1, 10), usage_source_kind, usage_ingestion`
    )
    .all(params) as Array<Record<string, unknown>>;
  const legacyFilters = makeLegacyFilters(filter);
  if (legacyFilters && !filter.apiKeyIds?.length) {
    const legacyWhere = legacyFilters.where.length
      ? `WHERE ${legacyFilters.where.join(" AND ")}`
      : "";
    const legacy = db
      .prepare(
        `SELECT date as day, 'unknown' as sourceKind, 'legacy' as ingestion,
          SUM(total_requests) as requests, 0 as inputReported, 0 as inputEstimated,
          SUM(total_input_tokens) as inputLegacyUnknown, 0 as inputUnavailableRequests,
          0 as outputReported, 0 as outputEstimated,
          SUM(total_output_tokens) as outputLegacyUnknown, 0 as outputUnavailableRequests,
          NULL as cacheReadReported, NULL as cacheCreationReported, NULL as reasoningReported,
          NULL as noCacheReported
        FROM daily_usage_summary ${legacyWhere} GROUP BY date`
      )
      .all(legacyFilters.params) as Array<Record<string, unknown>>;
    raw.push(...legacy);
  }
  return raw.sort(
    (a, b) =>
      String(b.day).localeCompare(String(a.day)) ||
      String(a.sourceKind).localeCompare(String(b.sourceKind))
  );
}

/** Provider/model token totals with prompt and completion provenance kept separate. */
export function getTokenUsageBreakdownRows(
  filter: TokenUsageFilter = {},
  dimension: "provider" | "model"
) {
  const db = getDbInstance();
  const column = dimension === "provider" ? "provider" : "model";
  const { where, params } = makeFilters(filter);
  const rawWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(${column}, ''), 'Unknown ${dimension}') as name,
        usage_source_kind as sourceKind, usage_ingestion as ingestion, COUNT(*) as requests,
        SUM(CASE WHEN usage_input_status = 'reported' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputReported,
        SUM(CASE WHEN usage_input_status = 'estimated' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputEstimated,
        SUM(CASE WHEN usage_input_status = 'legacy_unknown' THEN COALESCE(tokens_input, 0) ELSE 0 END) as inputLegacyUnknown,
        SUM(CASE WHEN usage_output_status = 'reported' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputReported,
        SUM(CASE WHEN usage_output_status = 'estimated' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputEstimated,
        SUM(CASE WHEN usage_output_status = 'legacy_unknown' THEN COALESCE(tokens_output, 0) ELSE 0 END) as outputLegacyUnknown
      FROM usage_history ${rawWhere}
      GROUP BY ${column}, usage_source_kind, usage_ingestion
      ORDER BY name`
    )
    .all(params) as Array<Record<string, unknown>>;

  const legacyFilters = makeLegacyFilters(filter);
  if (legacyFilters && !filter.apiKeyIds?.length) {
    const legacyWhere = legacyFilters.where.length
      ? `WHERE ${legacyFilters.where.join(" AND ")}`
      : "";
    const legacy = db
      .prepare(
        `SELECT COALESCE(NULLIF(${column}, ''), 'Unknown ${dimension}') as name,
          'unknown' as sourceKind, 'legacy' as ingestion, SUM(total_requests) as requests,
          0 as inputReported, 0 as inputEstimated, SUM(total_input_tokens) as inputLegacyUnknown,
          0 as outputReported, 0 as outputEstimated, SUM(total_output_tokens) as outputLegacyUnknown
        FROM daily_usage_summary ${legacyWhere} GROUP BY ${column} ORDER BY name`
      )
      .all(legacyFilters.params) as Array<Record<string, unknown>>;
    rows.push(...legacy);
  }
  return rows;
}

/** Connection state without selecting or returning credential columns. */
export function getUsageConnectionStatusRows() {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT c.provider, c.name as connectionName, c.auth_type as authType,
        c.is_active as isActive, c.test_status as testStatus,
        c.last_tested as lastTested, c.last_used_at as lastUsedAt,
        MAX(u.timestamp) as lastUsageAt
      FROM provider_connections c
      LEFT JOIN usage_history u ON u.connection_id = c.id
      GROUP BY c.id
      ORDER BY LOWER(c.provider), LOWER(COALESCE(c.name, ''))`
    )
    .all() as Array<Record<string, unknown>>;
}

/** Bounded, prompt-free export of detailed usage events and their provenance. */
export function getTokenUsageExportRows(filter: TokenUsageFilter = {}, limit = 50_000) {
  const db = getDbInstance();
  const { where, params } = makeFilters(filter);
  const rawWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id as eventId, timestamp, provider, model, usage_source_kind as sourceKind,
        usage_source_label as sourceLabel, usage_ingestion as ingestion,
        tokens_input as promptTokens, usage_input_status as inputStatus,
        tokens_input_source_reported as sourceReportedInput,
        tokens_output as completionTokens, usage_output_status as outputStatus,
        tokens_cache_read as cacheReadTokens, usage_cache_read_status as cacheReadStatus,
        tokens_cache_creation as cacheCreationTokens,
        usage_cache_creation_status as cacheCreationStatus,
        tokens_reasoning as reasoningTokens, usage_reasoning_status as reasoningStatus,
        tokens_no_cache as noCacheTokens, usage_no_cache_status as noCacheStatus,
        status as requestStatus, success, latency_ms as latencyMs
      FROM usage_history ${rawWhere}
      ORDER BY timestamp ASC, id ASC LIMIT @limit`
    )
    .all({ ...params, limit }) as Array<Record<string, unknown>>;
}
