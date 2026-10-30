# Initial Subject + PDF upload

This is a local-development API, protected by the existing `ChatGuard`. It does
not implement user authentication/ownership or PDF processing. Do not expose it as
a public multi-user endpoint without adding authorization and scoping keys/names.

## Contract

`POST /subjects/initial-upload` accepts multipart fields:

- `name`: the existing trimmed, nonempty Subject name.
- `idempotencyKey`: 8–128 characters, letters/digits/`.`/`_`/`:`/`-` (a UUID is suitable).
- `file`: exactly one PDF, nonempty, at most 256 MiB, PDF MIME type and extension,
  `%PDF-` signature, structurally readable, unencrypted, at least one page.

Send the same key, name, original filename and bytes when retrying. A changed
payload with the same key returns 409. Names remain globally case-insensitively
unique, including incomplete reservations. A new key does not resume an old Subject.

Accepted requests return HTTP 202 with:

```json
{
  "subjectId": "server-id",
  "documentId": null,
  "uploadStatus": "AWAITING_RETRY",
  "subjectStatus": "INCOMPLETE",
  "chatAvailable": false,
  "retryable": true,
  "errorCode": "FILE_REQUIRED"
}
```

When `uploadStatus` is `UPLOADED`, `documentId` is non-null and the new
Document.status is `QUEUED`, not `UPLOADED` or `READY`.
`GET /subjects/initial-upload/:idempotencyKey` returns the same status contract
without uploading. Unknown keys return 404. Invalid inputs return 400/413;
duplicate names or conflicting key reuse return 409. An unavailable database may
return a sanitized 503; always retain the same key after such a response.

## Duplicate PDFs

For a new idempotency key, initial upload checks the PDF SHA-256 without a Subject
scope. Bytes already present in any Subject are therefore reported as
`other_subject`.

Without `duplicateAction`, the request returns 409 with:

```json
{
  "code": "DUPLICATE_PDF",
  "scope": "other_subject",
  "existingDocumentId": "existing-document-id",
  "existingSubjectId": "existing-subject-id",
  "existingFilename": "existing.pdf",
  "allowedActions": ["keep_existing", "replace_existing"]
}
```

`keep_existing` is accepted. It does not reuse or modify the existing Document.
The upload still creates a new Subject, UploadAttempt and Document, but the new
Document's title is set to the existing Document's filename.

`replace_existing` is accepted for compatibility only. It performs no replacement
or deletion; the upload proceeds normally and the new Document keeps the uploaded
filename. Any other `duplicateAction` returns 400.

Neither this flow nor `POST /subjects` enables workspace chat. Both report
`INCOMPLETE` and `chatAvailable: false`. The existing ungrounded development chat
demo is separate; a future Subject-scoped chat API must enforce processed-document
readiness. No processing jobs are dispatched by this feature.

## Persistence and recovery

1. Validate PDF structure before reserving anything.
2. A short DB transaction creates Subject + UploadAttempt, reserving
   `<subjectId>/initial/<attemptId>.pdf`. Unique idempotency keys and name constraints
   arbitrate concurrent reservations. Rolled-back reservations leave no Subject.
3. Claim a five-minute lease using an atomic conditional update. HEAD the reserved
   key. PUT uses `If-None-Match: *`, Content-MD5 and an explicit 60-second timeout;
   metadata operations use 15-second timeouts. SDK automatic retries are disabled.
4. A valid HEAD receipt must match attempt ID, SHA-256 metadata, byte size and ETag.
   Then a short fenced DB transaction creates the Document and completes the attempt.
   No database transaction spans production R2 I/O.
5. A startup/every-minute reconciler claims up to ten unfinished, due attempts.
   Leases prevent concurrent workers; owner/expiry checks fence stale finalizers.
   Its queue is the database, so restarting the backend does not lose work.

Failure behavior:

- **PUT fails/times out:** keep the reserved key. A later HEAD determines whether
  the write actually succeeded. No duplicate object key is allocated.
- **R2 succeeds, DB fails:** retain the valid object and finalize later. Do not
  delete valid uploads merely because PostgreSQL is temporarily unavailable.
- **No object after interruption:** mark `AWAITING_RETRY`/`FILE_REQUIRED`; the client
  must resend the PDF with the original key. File bodies are not persisted in SQL.
- **Mismatched owned object:** persist `CLEANUP_PENDING` first. A later sweep may
  conditionally delete only that attempt's key and ETag, then await file replay.
  Cleanup failure stays pending. Unowned objects are never deleted automatically.
- **Client loses response:** the same payload/key returns the completed receipt.
- **Process dies with a lease:** a later sweep reclaims it after expiry.

Incomplete reservations are intentionally retained and reserve their names. This
feature does not silently remove Subjects, add cancellation, or delete legacy data.
The new foreign keys restrict deleting Subjects/Documents with upload receipts;
future deletion must explicitly coordinate object cleanup and ledger retention.

## Deployment and tests

Review and deploy `20261023170000_initial_upload_attempts` before starting the new
backend build. It only adds the enum, attempt table, checks, foreign keys and indexes.
Existing migration files and the legacy `POST /documents/upload` contract remain intact.

`npm test` uses mocked R2/DB resources, including HTTP integration tests.
After deployment, `npx tsx scripts/verify-initial-upload.ts` verifies real database
reservation/finalization and recovery with mocked R2, rolling back all fixture rows.
No real R2 objects are needed for these tests.

PDF validation is structural, not malware scanning or proof that OCR/extraction
will succeed. Processing and readiness transitions remain a separate implementation.
