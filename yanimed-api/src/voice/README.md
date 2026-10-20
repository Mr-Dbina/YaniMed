# Voice backend (local beta)

- `POST /voice/synthesize`: JSON `{ "text": "Hello", "voiceId": "CwhRBWXzGAHq8TQ4Fs17" }`. `voiceId` is optional; only verified Roger is supported. Trimmed text must contain 1–2000 characters. Returns MP3 (`audio/mpeg`).
- `POST /voice/transcribe`: multipart field `file`, maximum 10 MiB. Supports MP3, WAV, WebM, Ogg, MP4/M4A and FLAC with matching audio MIME/header. Returns `{ "text": "..." }`. Empty transcripts are permitted for silence; malformed/empty uploads are rejected. Header checks are preliminary; ElevenLabs performs decoding.
- Backend-only `ELEVENLABS_API_KEY` is read from the existing environment configuration. Missing configuration returns 503 without preventing unrelated API startup.
- Models: `eleven_flash_v2_5` and `scribe_v1`. No provider retries, audio persistence or transcript logging. Provider requests have a 60-second deadline, two concurrent requests and ten incoming requests/minute shared across both routes in this process.

## Access limitations

There is no application authentication. These routes are disabled with `NODE_ENV=production` and accept only loopback socket addresses without forwarded-address headers. Browser requests require an origin from `CORS_ORIGINS` (default `http://localhost:3001`); cross-site requests are rejected. Do not proxy these endpoints to public clients. Loopback restrictions are not identity authentication: local processes and same-origin code can use credits. Limits are per-process and reset on restart. Public deployment requires authenticated authorization, proxy-aware access controls and shared rate/quota controls before enabling voice routes.

The implementation does not alter server bindings or existing routes. Global Express JSON limits also apply to synthesis. Multipart bodies are memory-limited to one 10 MiB file, with no text fields. Deployment-level connection/body timeouts are still needed if public access is introduced.
