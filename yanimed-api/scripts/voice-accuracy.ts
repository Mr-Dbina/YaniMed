/**
 * Local voice accuracy check (not part of the test suite).
 *
 * Sends each term through VoiceStudio TTS once, then transcribes that audio
 * twice: without a vocabulary prompt and with LOCAL_STT_PROMPT-style hint.
 * Running it needs VoiceStudio on http://localhost:3900 and nothing else.
 *
 *   npx tsx scripts/voice-accuracy.ts
 *
 * Matching is deliberately loose: both sides are lowercased, then every
 * non-alphanumeric character is dropped, so "hydrochloro thiazide" still
 * counts as hydrochlorothiazide.
 */

const BASE_URL = (process.env.LOCAL_VOICE_BASE_URL ?? 'http://localhost:3900/v1').replace(/\/+$/, '');
const TTS_MODEL = process.env.LOCAL_TTS_MODEL ?? 'kittentts';
const TTS_VOICE = process.env.LOCAL_TTS_VOICE ?? 'expr-voice-2-f';
const STT_MODEL = process.env.LOCAL_STT_MODEL ?? 'faster-whisper';
const PROMPT = process.env.LOCAL_STT_PROMPT?.trim() ?? '';
const LANGUAGE = process.env.LOCAL_STT_LANGUAGE?.trim() ?? '';

const TERMS = [
  'Amoxicillin',
  'metformin',
  'atorvastatin',
  'omeprazole',
  'paracetamol',
  'hydrochlorothiazide',
  'lisinopril',
  'warfarin',
  'clopidogrel',
  'levothyroxine',
  'salbutamol',
  'ceftriaxone',
  'vancomycin',
  'prednisolone',
  'ibuprofen',
  'sternocleidomastoid',
  'gastrocnemius',
  'myocardium',
  'pericardium',
  'duodenum',
  'jejunum',
  'ileum',
  'trapezius',
  'deltoid',
  'patella',
];

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

async function synthesize(input: string): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status} for "${input}"`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe(audio: Buffer, prompt?: string): Promise<string> {
  const form = new FormData();
  form.set('model', STT_MODEL);
  form.set('response_format', 'json');
  if (LANGUAGE) form.set('language', LANGUAGE);
  if (prompt) form.set('prompt', prompt);
  form.set(
    'file',
    new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }),
    'term.mp3',
  );
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === 'string' ? data.text : '';
}

async function main() {
  const usePrompt = PROMPT.length > 0;
  let plainHits = 0;
  let promptHits = 0;

  console.log(
    `TTS ${TTS_MODEL}/${TTS_VOICE} → STT ${STT_MODEL} @ ${BASE_URL}` +
      (LANGUAGE ? ` language=${LANGUAGE}` : '') +
      (usePrompt ? ` (prompt: "${PROMPT}")` : ' (no prompt)') +
      '\n',
  );
  for (const term of TERMS) {
    const started = Date.now();
    const audio = await synthesize(term);
    const plain = await transcribe(audio);
    const plainHit = compact(plain).includes(compact(term));
    if (plainHit) plainHits++;
    const cells = [
      term.padEnd(22),
      plainHit ? 'PASS' : 'FAIL',
      `plain="${plain}"`,
    ];
    if (usePrompt) {
      const hinted = await transcribe(audio, PROMPT);
      const promptHit = compact(hinted).includes(compact(term));
      if (promptHit) promptHits++;
      cells.splice(2, 0, promptHit ? 'PASS' : 'FAIL');
      cells.push(`hinted="${hinted}"`);
    }
    cells.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(cells.join(' | '));
  }

  const pct = (n: number) => ((n / TERMS.length) * 100).toFixed(0);
  console.log(
    `\nNo prompt: ${plainHits}/${TERMS.length} (${pct(plainHits)}%)` +
      (usePrompt
        ? `  With prompt: ${promptHits}/${TERMS.length} (${pct(promptHits)}%)`
        : ''),
  );
}

await main();
