---
title: Token usage tracking
description: How OmniRoute records, labels, imports, and exports token usage.
lastUpdated: 2026-10-01
---

# Token usage tracking

OmniRoute records usage for requests that pass through its local router. Open **OmniRoute AI
Gateway** from your Linux app menu or desktop launcher. The launcher starts the existing local
user service when needed and opens it in an app-style browser window at `localhost:20128`. Open
**Usage** to see date, API-key, provider, and model filters, daily trends, provider/model tables,
source status, and monthly provenance breakdown. The request logger also filters individual
requests by date, provider, and model.

## Connect a source

1. Open **Providers** and add a supported provider connection, or point a local-provider
   connection at its existing model server.
2. Send a request through OmniRoute. The collector reads usage fields in the provider response;
   it does not scan other applications or their private databases.
3. For supported local runtimes, configure their normal API endpoint in OmniRoute (for example
   Ollama, LM Studio, or vLLM). A local request is recorded as local when the response contains
   token counts. A compatible runtime that omits those counts will be shown as estimated or
   unavailable, never as an exact server count.

Only a connection's configured/test state and last request/test time are shown. An idle source can
be healthy even when it has no recent usage.

## Reported, estimated, and unavailable counts

- **Reported** means the connected provider or local server returned that field. An explicit zero
  is retained as zero.
- **Estimated** means OmniRoute produced a heuristic count because the source omitted a count or
  its input count failed a plausibility check. The source-reported input value is retained and
  shown separately when one existed.
- **Unavailable** means the source did not provide that token field. It is not converted into a
  zero.
- **Legacy unknown** means an older database row predates provenance tracking, so OmniRoute
  cannot determine whether its count was reported or estimated.

Cache read, cache creation, reasoning, and non-cached input fields are stored only when the source
supplied them. Non-cached input is a subcategory of the input total and is not added a second time.
Prompt/completion estimates are not used to invent these categories or subscription quota counts.
Cost figures marked with ≈ are estimates from configured token prices; when no matching price is
known, the dashboard shows a dash instead of a zero cost. Flat-rate plans are not converted into
per-request cost. The existing summary charts can combine reported and estimated token values; the
dashboard's daily, monthly, provider, model, and source provenance tables show their split.

## Subscriptions and external sources

ChatGPT/Codex subscription quota or billing totals are not token totals. OmniRoute does not
scrape private ChatGPT/Codex databases or turn quota percentages into token counts. If a routed
response contains usage metadata, that request's reported/estimated counts are shown separately;
they are not the account's subscription total.

To add history that OmniRoute did not observe, use **Import usage JSON**. This accepts normalized
metadata only; the browser sends an allow-listed set of timestamps, provider/model names, source
class, token counts, and provenance. It does not send prompts, completions, credentials, or other
file fields.

```json
{
  "events": [
    {
      "eventId": "provider-event-123",
      "timestamp": "2026-09-30T10:15:00.000Z",
      "provider": "openai",
      "model": "gpt-5",
      "sourceKind": "cloud-api",
      "promptTokens": 42,
      "completionTokens": 17,
      "inputStatus": "reported",
      "outputStatus": "reported",
      "cacheReadTokens": 0,
      "cacheReadStatus": "reported",
      "noCacheTokens": 42,
      "noCacheStatus": "reported"
    }
  ]
}
```

`sourceKind` can be `local`, `cloud-api`, `subscription`, `imported`, or `unknown`. Counts are
non-negative integers. Omit token fields the source did not provide, and include an explicit
`inputStatus` and `outputStatus` whenever those counts are present. Mark estimates as `estimated`;
do not default an unknown count to `reported`. `eventId`
helps avoid importing the same record twice. The importer accepts at most 5,000 events (10 MB).

**Export usage JSON** downloads the selected date range and API-key filter, up to 50,000 events.
It includes token counts and provenance but no prompt, completion, credential, or raw request-body
content. The export uses the same normalized event fields and can be imported again.

## Local storage and credentials

Usage history remains in OmniRoute's local SQLite database. Provider credentials are encrypted in
that database; the Linux desktop launcher stores its database-encryption key in GNOME Keyring or
another Secret Service through OmniRoute's existing `keytar` dependency. Electron builds protect
the same key with Electron `safeStorage`. On Linux both launch paths require an unlocked secure
keyring. The browser-app launcher migrates a legacy key out of `server.env` on startup and restricts
that file to the owner. If the keyring is unavailable, unlock or install it, then reopen the app.
Do not delete the database or generate a replacement key if OmniRoute reports that an existing
encrypted database key is missing; restore the prior key from a backup first.

This tracker adds no upload or background polling. Cloud model requests still go to the provider
you configured, as required to run them. Optional OmniRoute sync or log-export connections remain
separate settings that you must configure yourself.

The desktop defaults to its bundled local server. If you deliberately switch the app to remote
server mode, that server owns the database and usage history, so the data is no longer local to
this desktop.

## Sources that cannot be tracked reliably

- **ChatGPT/Codex subscription-wide totals:** no supported token-total source is available to this
  collector; quota snapshots are not usage counts. Import a provider-supplied export if you have
  one.
- **Provider API traffic outside OmniRoute:** no exact per-request history is available unless the
  provider supplies a suitable usage event/export and you import it. Account billing or cost
  endpoints do not necessarily include prompt/completion token counts.
- **Local runtimes used directly by another app:** OmniRoute cannot observe those requests. Route
  them through OmniRoute or import a chosen usage file.
- **Responses without token metadata:** a local estimate may be available from the request and
  response text; otherwise the field stays unavailable. Estimates do not become provider-reported
  totals.
- **Aggregated historical rows from before this change:** the older schema did not retain enough
  provenance to distinguish reported counts from estimates; those values remain labeled legacy
  unknown.
