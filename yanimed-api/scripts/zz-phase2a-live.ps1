# ZZ-PHASE2A-TEST live verification. Run manually in PowerShell. Do not run unattended.
# This script performs real uploads and writes to Supabase/R2. It does not clean up.

param([string]$ResumeKeyA)

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
  $json = $null
  try { $json = $body | ConvertFrom-Json } catch {}
  Log "HTTP $method $url => $code"
  Log "BODY: $body"
  return [pscustomobject]@{ StatusCode = [int]$code; Body = $body; Json = $json }
}

if ($ResumeKeyA) {
  $keyA = $ResumeKeyA
  if (-not (Test-Path $pdfPath)) { Fail 'Resume requires the existing PDF at $env:TEMP\zz-phase2a.pdf.' }
} else {
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
}
$keyB = "zz-phase2a-b-$(Get-Date -Format yyyyMMddHHmmss)"

function Upload($name, $key, $action) {
  $form = @("name=$name", "idempotencyKey=$key", "file=@$pdfPath;type=application/pdf")
  if ($action) { $form += "duplicateAction=$action" }
  return Http 'POST' "$api/subjects/initial-upload" $null $form
}

# a) Subject A
$a = Upload 'ZZ-PHASE2A-TEST-A' $keyA $null
if ($a.StatusCode -ne 202) { Fail "Step a expected 202, got $($a.StatusCode): $($a.Body)" }
if ($a.Json.uploadStatus -eq 'AWAITING_RETRY' -or $a.Json.errorCode) { Fail "Step a failed: $($a.Body)" }
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
