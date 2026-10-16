import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getTokenUsageExportRows } from "@/lib/db/tokenUsageAnalytics";

export const dynamic = "force-dynamic";

function getRangeStart(range: string): string | null {
  const days: Record<string, number> = {
    "1d": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "180d": 180,
    "365d": 365,
  };
  if (range === "all") return null;
  if (range === "ytd") {
    const start = new Date();
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  const dayCount = days[range] || 30;
  return new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000).toISOString();
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";
    const sinceIso = searchParams.get("startDate") || getRangeStart(range);
    const untilIso = searchParams.get("endDate");
    const apiKeyIds = (searchParams.get("apiKeyIds") || "")
      .split(",")
      .filter(Boolean)
      .slice(0, 100);
    const provider = searchParams.get("provider") || "";
    const model = searchParams.get("model") || "";
    const rows = getTokenUsageExportRows(
      { sinceIso, untilIso, apiKeyIds, provider, model },
      50_001
    );
    const events = rows.slice(0, 50_000);
    const payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      count: events.length,
      capped: rows.length > 50_000,
      note: "Usage metadata only. No prompts, completions, credentials, or raw request bodies are exported.",
      events,
    });
    const date = new Date().toISOString().slice(0, 10);
    return new Response(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="omniroute-usage-${date}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to export usage history." },
      { status: 500 }
    );
  }
}
