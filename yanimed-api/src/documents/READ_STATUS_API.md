# Read/status and manual retry API

Mutating routes retain ChatGuard: single-user local development only, allowed origin,
loopback connection, no forwarded headers, unavailable in production. The existing
10 requests/minute guard applies; polling clients must account for this. Read-only GET
routes are not guarded.

## Routes

- `GET /subjects`: array of `{ id, name, createdAt, updatedAt, documentCount }`.
- `GET /subjects/:subjectId`: same metadata object, or 404.
- `GET /subjects/:subjectId/documents`: array of document metadata, or 404 when
  the Subject does not exist. Existing Subjects without documents return `[]`.
- `GET /documents/:documentId/status`: document metadata plus readiness/retry fields.
- `POST /documents/:documentId/retry`: queue a new processing attempt and return 202.

Path IDs must be UUIDs (400 otherwise). Lists use `createdAt ASC, id ASC`.
Database failures return sanitized 503 responses. Status reads issue no database
writes, storage requests, provider requests, or processing jobs. Retry is the only
route in this group that writes.

Document metadata fields: `documentId`, `subjectId`, `filename` (stored title),
`status`, `createdAt`, `updatedAt`, `pageCount` (nullable), `processedPages`,
`embeddedChunks`, `ocrPages`. Counts are persisted values, not percentages.
`updatedAt` is the record update time, not a stage completion timestamp.

Status adds:

```json
{
  "readyForRetrieval": false,
  "retryAllowed": true,
  "retryUnavailableReason": null,
  "failure": {
    "code": "OCR_PAGE_LIMIT_EXCEEDED",
    "message": "Document exceeds the configured OCR page limit. Raise the OCR page limit, then retry.",
    "retryAllowed": true
  }
}
```

`readyForRetrieval` is true only for persisted `READY`. This reports the existing
pipeline's decision; it does not run a new vector-integrity audit or promote a
document based on counters or an UploadAttempt receipt.

`retryAllowed` is true only when the persisted Document is `FAILED` and its latest
ProcessingJob is not `QUEUED`, `RUNNING` or `RETRY_WAIT`. When retry is not allowed,
`retryUnavailableReason` is `NOT_FAILED` (the Document is not `FAILED`) or
`RETRY_IN_PROGRESS` (an active job exists); it is null when retry is allowed.

`failure` is present only for `FAILED` documents. `code` comes from a fixed whitelist
of known processing codes (`OCR_PAGE_LIMIT_EXCEEDED`, `OCR_PAGE_TIMEOUT`,
`OCR_TIME_BUDGET_EXCEEDED`, `PROCESSING_TIME_BUDGET_EXCEEDED`,
`LEASE_EXPIRED_MAX_ATTEMPTS`, `EMBEDDING_TRANSIENT`, `EMBEDDING_PERMANENT`,
`STORAGE_TRANSIENT`, `STORAGE_PERMANENT`, `DB_TRANSIENT`); any other value becomes
`PROCESSING_FAILED`. Each code maps to a fixed safe message. Stored `errorMessage`
and raw provider text are never selected or returned. For `OCR_PAGE_LIMIT_EXCEEDED`
the message tells the operator to raise the OCR page limit before retrying.

When the latest job is `RETRY_WAIT`, status also includes:

```json
{
  "processing": { "attempt": 2, "maxAttempts": 4, "nextRunAt": "2026-10-24T00:05:00.000Z" }
}
```

`processing` is omitted for every other job status.

## Manual retry

`POST /documents/:documentId/retry` requires ChatGuard (local development, allowed
origin, loopback connection, no forwarded headers) and responds with:

- `202 { "documentId": "<uuid>", "status": "QUEUED" }` when a new attempt is queued.
- `404` when the Document does not exist.
- `409 { "code": "RETRY_NOT_ALLOWED", "reason": "NOT_FAILED" | "RETRY_IN_PROGRESS" }`
  when the Document is not `FAILED` or an active job already exists.
- `503` with a sanitized message on database failure.

Retry is allowed for a `FAILED` Document with no active ProcessingJob, for any
failure code. In one transaction the service locks the Document, verifies the status
and active-job absence, inserts a new ProcessingJob (`attempt` 0, `QUEUED`,
`nextRunAt` now), sets the Document to `QUEUED` and clears its `errorMessage`, then
returns the new job id. A unique-index race on
`ProcessingJob_documentId_active_key` is reported as `RETRY_IN_PROGRESS`. After the
transaction the service schedules a drain without blocking the 202 response; a
`QUEUED` Document with an active job is also picked up by the reconciler within 30s.
CONFIG failures are retryable but fail fast again unless the configuration was
corrected first.

No worker changes or migrations are part of this phase. Backend restart activates
existing reconcilers; perform live smoke verification after a controlled restart.
