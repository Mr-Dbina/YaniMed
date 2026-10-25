# ZZ-PHASE2A-TEST live verification. Run manually in PowerShell. Do not run unattended.
# This script performs real uploads and writes to Supabase/R2. It does not clean up.

$ErrorActionPreference = 'Stop'
$api = 'http://localhost:3000'
$webOrigin = 'http://localhost:3001'
$tmp = $env:TEMP
$pdfPath = Join-Path $tmp 'zz-phase2a.pdf'
$logPath = Join-Path $tmp 'zz-phase2a-live.log'
$backendDir = 'C:\Users\chris\OneDrive\Desktop\YaniMed\yanimed-api'

function Log($message) {
  $line = "$(Get-Date -Format o) $message"
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line
}

function Fail($message) {
  Log "ABORT: $message"
  throw $message
}

function Http($method, $url, $bodyFile, $form) {
  $outFile = Join-Path $tmp 'zz-response.json'
  $codeFile = Join-Path $tmp 'zz-code.txt'
  $curlArgs = @('-sS', '--max-time', '120', '-X', $method, $url, '-H', "Origin: $webOrigin", '-o', $outFile, '-w', '%{http_code}', '-D', $codeFile)
  if ($bodyFile) { $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile") }
  if ($form) { foreach ($item in $form) { $curlArgs += @('-F', $item) } }
  $code = & curl.exe @curlArgs
  $body = if (Test-Path $outFile) { Get-Content $outFile -Raw } else { '' }
  Log "HTTP $method $url => $code"
  Log "BODY: $body"
  return [pscustomobject]@{ StatusCode = [int]$code; Body = $body; Json = (try { $body | ConvertFrom-Json } catch { $null }) }
}

# Pre-check
$subjectsRaw = (Http 'GET' "$api/subjects" $null $null).Body
$subjects = try { $subjectsRaw | ConvertFrom-Json } catch { @() }
if ($subjects | Where-Object { $_.name -like 'ZZ-PHASE2A-TEST*' }) {
  Fail 'A ZZ-PHASE2A-TEST Subject already exists. Clean up first or choose a new test name.'
}

# Generate a tiny unique 1-page text PDF from the backend directory so pdf-lib resolves.
if (-not (Test-Path (Join-Path $backendDir 'node_modules\pdf-lib'))) { Fail 'pdf-lib is not installed in yanimed-api.' }
Push-Location $backendDir
node -e "const fs=require('fs');const{PDFDocument,StandardFonts}=require('pdf-lib');(async()=>{const p=await PDFDocument.create();const f=await p.embedFont(StandardFonts.Helvetica);const pg=p.addPage();pg.drawText('ZZ-PHASE2A-TEST '+Date.now(),{x:50,y:700,size:12,font:f});fs.writeFileSync(process.argv[1],Buffer.from(await p.save()));})();" $pdfPath
Pop-Location
if (-not (Test-Path $pdfPath)) { Fail 'PDF generation failed.' }
$sha = (Get-FileHash $pdfPath -Algorithm SHA256).Hash.ToLower()
$canonical = "pdfs/$sha.pdf"
Log "SHA256=$sha"
Log "CANONICAL=$canonical"

$stamp = Get-Date -Format yyyyMMddHHmmss
$keyA = "zz-phase2a-a-$stamp"
$keyB = "zz-phase2a-b-$stamp"

function Upload($name, $key, $action) {
  $form = @("name=$name", "idempotencyKey=$key", "file=@$pdfPath;type=application/pdf")
  if ($action) { $form += "duplicateAction=$action" }
  return Http 'POST' "$api/subjects/initial-upload" $null $form
}

# a) Subject A
$a = Upload 'ZZ-PHASE2A-TEST-A' $keyA $null
if ($a.StatusCode -ne 202) { Fail "Step a expected 202, got $($a.StatusCode)" }
if (-not $a.Json.subjectId) { Fail 'Step a missing subjectId' }
if (-not $a.Json.documentId) { Fail 'Step a missing documentId' }

# Poll A until UPLOADED
$deadline = (Get-Date).AddMinutes(2)
do {
  Start-Sleep -Seconds 5
  $status = Http 'GET' "$api/subjects/initial-upload/$keyA" $null $null
  if ($status.StatusCode -ne 200) { Fail "Step a poll expected 200, got $($status.StatusCode)" }
  if ($status.Json.uploadStatus -eq 'UPLOADED') { break }
  if ((Get-Date) -gt $deadline) { Fail 'Step a timed out waiting for UPLOADED' }
} while ($true)
Log "Step a receipt: $($status.Body)"

# b) Replay A
$a2 = Upload 'ZZ-PHASE2A-TEST-A' $keyA $null
if ($a2.StatusCode -ne 202) { Fail "Step b expected 202, got $($a2.StatusCode)" }
if ($a2.Json.subjectId -ne $a.Json.subjectId -or $a2.Json.documentId -ne $a.Json.documentId) {
  Fail "Step b replay returned a different receipt"
}
$subjectsAfterB = (Http 'GET' "$api/subjects" $null $null).Json
$zzCount = @($subjectsAfterB | Where-Object { $_.name -like 'ZZ-PHASE2A-TEST*' }).Count
if ($zzCount -ne 1) { Fail "Step b expected exactly 1 ZZ Subject, got $zzCount" }

# c) Subject B same bytes, no action
$c = Upload 'ZZ-PHASE2A-TEST-B' $keyB $null
if ($c.StatusCode -ne 409) { Fail "Step c expected 409, got $($c.StatusCode)" }
if ($c.Json.code -ne 'DUPLICATE_PDF' -or $c.Json.scope -ne 'other_subject') {
  Fail "Step c expected DUPLICATE_PDF/other_subject"
}
$subjectsAfterC = (Http 'GET' "$api/subjects" $null $null).Json
$zzCount = @($subjectsAfterC | Where-Object { $_.name -like 'ZZ-PHASE2A-TEST*' }).Count
if ($zzCount -ne 1) { Fail "Step c expected exactly 1 ZZ Subject, got $zzCount" }

# d) Subject B with keep_existing
$d = Upload 'ZZ-PHASE2A-TEST-B' $keyB 'keep_existing'
if ($d.StatusCode -ne 202) { Fail "Step d expected 202, got $($d.StatusCode)" }
$deadline = (Get-Date).AddMinutes(2)
do {
  Start-Sleep -Seconds 5
  $statusB = Http 'GET' "$api/subjects/initial-upload/$keyB" $null $null
  if ($statusB.StatusCode -ne 200) { Fail "Step d poll expected 200, got $($statusB.StatusCode)" }
  if ($statusB.Json.uploadStatus -eq 'UPLOADED') { break }
  if ((Get-Date) -gt $deadline) { Fail 'Step d timed out waiting for UPLOADED' }
} while ($true)
Log "Step d receipt: $($statusB.Body)"

# e) Poll document status sequentially
function Poll-Document($documentId) {
  for ($i = 0; $i -lt 18; $i++) {
    Start-Sleep -Seconds 12
    $r = Http 'GET' "$api/documents/$documentId/status" $null $null
    if ($r.StatusCode -ne 200) { Fail "Status poll failed for $documentId with $($r.StatusCode)" }
    Log "DOCUMENT $documentId => $($r.Json.status)"
    if ($r.Json.status -eq 'READY') { return $r.Json }
    if ($r.Json.status -eq 'FAILED') { Fail "Document $documentId failed: $($r.Json.failure.message)" }
  }
  Fail "Timed out waiting for $documentId"
}
Poll-Document $a.Json.documentId
Poll-Document $statusB.Json.documentId

Log "SUBJECT_A_ID=$($a.Json.subjectId)"
Log "DOCUMENT_A_ID=$($a.Json.documentId)"
Log "SUBJECT_B_ID=$($statusB.Json.subjectId)"
Log "DOCUMENT_B_ID=$($statusB.Json.documentId)"
Log "SHA256=$sha"
Log "CANONICAL_KEY=$canonical"
```

### verify-phase2a-live.ts

```ts
import { PrismaClient } from '@prisma/client';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();
const subjectIds = process.argv.slice(2);
if (subjectIds.length !== 2) {
  console.error('Usage: npx tsx verify-phase2a-live.ts <subjectAId> <subjectBId>');
  process.exit(1);
}

const r2 = new S3Client({
  region: process.env.R2_JURISDICTION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const bucket = process.env.R2_BUCKET_NAME!;

async function head(key: string) {
  try {
    const result = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: result.ContentLength ?? -1 };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return { exists: false, size: -1 };
    throw error;
  }
}

async function main() {
  const subjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } }, include: { documents: true, initialUpload: true } });
  console.log('COUNTS:', JSON.stringify({
    subjects: await prisma.subject.count(),
    documents: await prisma.document.count(),
    pdfObjects: await prisma.pdfObject.count(),
    uploadAttempts: await prisma.uploadAttempt.count(),
    documentPages: await prisma.documentPage.count(),
    chunks: await prisma.chunk.count(),
    deletionJobs: await prisma.deletionJob.count(),
  }));

  for (const subject of subjects) {
    console.log('SUBJECT:', subject.id, subject.name, 'documents=' + subject.documents.length);
    for (const document of subject.documents) {
      console.log('  DOCUMENT:', document.id, document.title, document.status, 'fileUrl=' + document.fileUrl, 'pdfObjectId=' + document.pdfObjectId);
      const pdfObject = document.pdfObjectId ? await prisma.pdfObject.findUnique({ where: { id: document.pdfObjectId } }) : null;
      console.log('  PDF_OBJECT:', pdfObject ? `${pdfObject.id} sha256=${pdfObject.sha256} r2Key=${pdfObject.r2Key} sizeBytes=${pdfObject.sizeBytes}` : 'MISSING');
      if (pdfObject) {
        const canonicalHead = await head(pdfObject.r2Key);
        console.log('  CANONICAL_HEAD:', pdfObject.r2Key, canonicalHead.exists ? `exists size=${canonicalHead.size}` : 'MISSING');
        console.log('  ASSERT canonical key equals pdfs/<sha256>.pdf:', pdfObject.r2Key === `pdfs/${pdfObject.sha256}.pdf` ? 'PASS' : 'FAIL');
        console.log('  ASSERT document.fileUrl equals pdfObject.r2Key:', document.fileUrl === pdfObject.r2Key ? 'PASS' : 'FAIL');
        console.log('  ASSERT canonical size equals sizeBytes:', canonicalHead.exists && canonicalHead.size === pdfObject.sizeBytes ? 'PASS' : 'FAIL');
      }
      if (subject.initialUpload?.objectKey) {
        const stagingHead = await head(subject.initialUpload.objectKey);
        console.log('  STAGING_HEAD:', subject.initialUpload.objectKey, stagingHead.exists ? 'EXISTS (unexpected)' : 'absent (expected)');
      }
    }
  }

  const shared = await prisma.pdfObject.groupBy({ by: ['sha256'], _count: { sha256: true }, having: { sha256: { _count: { gt: 1 } } } });
  console.log('DUPLICATE_PDF_OBJECT_SHA256_ROWS:', shared.length === 0 ? 'PASS' : 'FAIL');
}

main().catch(error => {
  console.error('VERIFY FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
```

### cleanup-phase2a-live.ts

```ts
import { PrismaClient } from '@prisma/client';
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const execute = process.argv.includes('--execute');
const ids = process.argv.filter(arg => !arg.startsWith('--'));
if (ids.length !== 2) {
  console.error('Usage: npx tsx cleanup-phase2a-live.ts <subjectAId> <subjectBId> [--execute]');
  process.exit(1);
}

const prisma = new PrismaClient();
const r2 = new S3Client({
  region: process.env.R2_JURISDICTION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const bucket = process.env.R2_BUCKET_NAME!;

async function head(key: string) {
  try {
    const result = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: result.ContentLength ?? -1 };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return { exists: false, size: -1 };
    throw error;
  }
}

async function main() {
  const subjects = await prisma.subject.findMany({ where: { id: { in: ids } } });
  if (subjects.length !== 2 || subjects.some(subject => !subject.name.startsWith('ZZ-PHASE2A-TEST'))) {
    throw new Error('Refusing cleanup: subjects must exist and both names must start with ZZ-PHASE2A-TEST.');
  }

  const documents = await prisma.document.findMany({ where: { subjectId: { in: ids } } });
  const uploadAttempts = await prisma.uploadAttempt.findMany({ where: { subjectId: { in: ids } } });
  const pdfObjectIds = [...new Set(documents.map(document => document.pdfObjectId).filter(Boolean))] as string[];
  const pdfObjects = pdfObjectIds.length ? await prisma.pdfObject.findMany({ where: { id: { in: pdfObjectIds } } }) : [];

  console.log('DRY RUN:', !execute);
  console.log('SUBJECTS:', subjects.map(s => s.id));
  console.log('DOCUMENTS:', documents.map(d => d.id));
  console.log('UPLOAD_ATTEMPTS:', uploadAttempts.map(a => a.id));
  console.log('PDF_OBJECTS:', pdfObjects.map(p => p.id));
  console.log('STAGING_KEYS:', uploadAttempts.map(a => a.objectKey));
  console.log('CANONICAL_KEYS:', pdfObjects.map(p => p.r2Key));

  if (!execute) {
    console.log('No changes made. Re-run with --execute to delete.');
    return;
  }

  await prisma.$transaction(async tx => {
    await tx.messageCitation.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.message.deleteMany({ where: { chatId: { in: (await tx.chat.findMany({ where: { subjectId: { in: ids } }, select: { id: true } })).map(c => c.id) } } });
    await tx.chat.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.chunk.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.documentPage.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.uploadAttempt.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.deletionJob.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.document.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.subject.deleteMany({ where: { id: { in: ids } } });

    for (const pdfObject of pdfObjects) {
      const remaining = await tx.document.count({ where: { pdfObjectId: pdfObject.id } });
      if (remaining === 0) {
        await tx.pdfObject.delete({ where: { id: pdfObject.id } });
      } else {
        console.log('KEEPING_PDF_OBJECT_WITH_REMAINING_REFERENCES:', pdfObject.id, remaining);
      }
    }
  });

  for (const attempt of uploadAttempts) {
    const existing = await head(attempt.objectKey);
    if (existing.exists) {
      console.log('DELETING_STAGING:', attempt.objectKey);
      await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: attempt.objectKey }));
    }
  }

  for (const pdfObject of pdfObjects) {
    const remaining = await prisma.document.count({ where: { pdfObjectId: pdfObject.id } });
    if (remaining === 0 && pdfObject.r2Key === `pdfs/${pdfObject.sha256}.pdf`) {
      const existing = await head(pdfObject.r2Key);
      if (existing.exists) {
        console.log('DELETING_CANONICAL:', pdfObject.r2Key);
        await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: pdfObject.r2Key }));
      }
    } else {
      console.log('KEEPING_CANONICAL:', pdfObject.r2Key, 'remainingDocuments=' + remaining);
    }
  }
}

main().catch(error => {
  console.error('CLEANUP FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
```

### Verification

- `npm run build`: PASS
- `npm test`: **199 passed, 19 files**
- `npx prisma migrate status`: **Database schema is up to date!**
- Counts: Subjects 0, Documents 0, PdfObjects 0, UploadAttempts 0, DeletionJobs 0

### Final status

PID 6824 is older than the final build. A user-run restart is required. No live upload, R2 write, DB write, or cleanup was performed. The three scripts above were written but not run. No Phase 2B work was started. No code, schema, migration, or data changes were made in this planning round. Awaiting approval before running the live check.<|end|><|start|>tool_call_begin|xml<|message|><rfl:parameter name="command">
cd C:\Users\chris\OneDrive\Desktop\YaniMed\yanimed-api; git add -A; git status --short | Select-Object -Last 10