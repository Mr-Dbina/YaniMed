# POST /documents/upload

This local-development endpoint remains available and is protected by the
existing `ChatGuard`.

## Request

Send `multipart/form-data` with:

- `subjectId`: required. The value must match an existing Subject whose status is
  `ACTIVE`.
- `duplicateAction`: optional. Accepted values depend on the duplicate scope
  described below.
- `file`: required. Exactly one PDF, nonempty and at most 256 MiB. The MIME type
  must be `application/pdf`, the bytes must begin with `%PDF-`, and the filename
  must end with `.pdf` after sanitization.

The multipart parser accepts at most one file, two text fields and three parts.

## Normal response

A successful create returns HTTP 201 with:

```json
{
  "documentId": "document-id",
  "filename": "uploaded.pdf",
  "subjectId": "subject-id",
  "status": "QUEUED",
  "storageKey": "pdfs/hash.pdf"
}
```

`status` is the current persisted `Document.status`; a newly created Document
starts as `QUEUED`. `storageKey` is the Document's `fileUrl`.

## Same-Subject duplicate

If the uploaded SHA-256 already belongs to a Document in the requesting Subject
and `duplicateAction` is absent, the endpoint returns HTTP 409:

```json
{
  "code": "DUPLICATE_PDF",
  "scope": "same_subject",
  "existingDocumentId": "document-id",
  "existingSubjectId": "subject-id",
  "existingFilename": "existing.pdf",
  "allowedActions": ["keep_existing"]
}
```

Sending `duplicateAction=keep_existing` returns HTTP 200 with the existing
Document's five fields, without creating a Document, uploading the new bytes,
calling `ensureFromBuffer`, or scheduling processing:

```json
{
  "documentId": "document-id",
  "filename": "existing.pdf",
  "subjectId": "subject-id",
  "status": "READY",
  "storageKey": "pdfs/hash.pdf"
}
```

Any other `duplicateAction` for a same-Subject duplicate returns HTTP 400 with
`duplicateAction is not valid for this upload.` That includes
`replace_existing` and the removed `upload_anyway` value.

## Other-Subject duplicate

If the SHA-256 belongs to a Document in a different Subject and
`duplicateAction` is absent, the endpoint returns HTTP 409:

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

With `duplicateAction=keep_existing`, the request proceeds normally and creates a
new Document in the requesting Subject. The new Document's title is the existing
Document's filename. The existing Document is not reused or modified.

With `duplicateAction=replace_existing`, the request also proceeds normally and
creates a new Document in the requesting Subject using the uploaded filename.
There is no replacement or deletion of the existing Document.

Both accepted actions return HTTP 201 with the normal response body. Any other
`duplicateAction` returns HTTP 400.

## P2002 race

If the insert loses a concurrent race against the
`Document_subjectId_pdfObjectId_key` unique index, the endpoint looks up the
existing oldest Document for the same Subject and PdfObject and returns the same
HTTP 409 body as the same-Subject duplicate case, with
`allowedActions: ["keep_existing"]`. If no matching Document is found, or the
P2002 violation is for a different unique constraint, the original error is
rethrown.

## Other errors

- HTTP 400: the Subject does not exist or is not `ACTIVE`
  (`Subject does not exist.`).
- HTTP 400: the PDF is missing, has the wrong MIME type, has an invalid or
  mismatched size, lacks the `%PDF-` signature, or does not have a `.pdf`
  filename.
- HTTP 400: `duplicateAction` is not valid for the duplicate scope.
- HTTP 413: the multipart file exceeds the 256 MiB file-size limit enforced by
  the upload interceptor.
