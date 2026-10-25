# Phase 1 read/status API

All routes retain ChatGuard: single-user local development only, allowed origin,
loopback connection, no forwarded headers, unavailable in production. The existing
10 requests/minute guard applies; polling clients must account for this.

## Routes

- `GET /subjects`: array of `{ id, name, createdAt, updatedAt, documentCount }`.
- `GET /subjects/:subjectId`: same metadata object, or 404.
- `GET /subjects/:subjectId/documents`: array of document metadata, or 404 when
  the Subject does not exist. Existing Subjects without documents return `[]`.
- `GET /documents/:documentId/status`: document metadata plus readiness/retry fields.

Path IDs must be UUIDs (400 otherwise). Lists use `createdAt ASC, id ASC`.
Database failures return sanitized 503 responses. Reads issue no database writes,
storage requests, provider requests, or processing jobs.

Document metadata fields: `documentId`, `subjectId`, `filename` (stored title),
`status`, `createdAt`, `updatedAt`, `pageCount` (nullable), `processedPages`,
`embeddedChunks`, `ocrPages`. Counts are persisted values, not percentages.
`updatedAt` is the record update time, not a stage completion timestamp.

Status adds:

```json
{
  "readyForRetrieval": false,
  "retryAllowed": false,
  "retryUnavailableReason": "CONTROLLED_RETRY_NOT_AVAILABLE",
  "failure": null
}
```

`readyForRetrieval` is true only for persisted `READY`. This reports the existing
pipeline's decision; it does not run a new vector-integrity audit or promote a
document based on counters or an UploadAttempt receipt. FAILED returns a generic
`PROCESSING_FAILED` failure object. Raw stored provider errors are never selected
or returned. R2 keys, signed URLs, text, embeddings and credentials are excluded.

## Retry deliberately deferred

There is no `POST /documents/:documentId/retry` route. The current processor accepts
PROCESSING as a claimable state, has process-local locking only, and restarts
extraction/chunking (which deletes and recreates chunks). Its lock cleanup compares
different Promise instances. Merely exposing `schedule()` would not guarantee safe
retry or preservation of successful results.

Before exposing retry, approve a focused recovery change: correct/coalesce the
in-process lock, coordinate every scheduling path, restrict retry to FAILED, and
preserve completed chunks/vectors through validated checkpoints. Multiple workers
require a database-backed claim/fencing design (and potentially an additive
migration), not a claim that the existing status update is a lease.

No worker changes or migrations are part of this phase. Backend restart activates
existing reconcilers; perform live smoke verification after a controlled restart.
