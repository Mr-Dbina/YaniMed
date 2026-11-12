# PLE Reviewer — Settings Screen Tour

Captured from the running app at `http://localhost:3001` on 2026-10-17.

These are the **six settings sections that actually exist today**.

---

## 01 — General → `01-general.png`

**What it shows:** a single *Language* row with an "Auto detect" dropdown.

**What it does:** picks the display language for menus and labels.

**Status: cosmetic.** The list is hardcoded (30 languages) and the choice is
not saved — it resets when you refresh. Source comment: *"TODO: persist once
the app has settings storage."*

---

## 02 — Appearance → `02-appearance.png`

**What it shows:** Mode thumbnails (System / Light / Dark), Theme name, Accent
colour `#746B63`, Background `#FAF8F5`, Foreground `#1C1917`, and an
**Advanced** panel.

**What it does:** switches light/dark and sets the app's colours.

**Status: partly working.** Mode is the one setting that **is** saved (it
persists across refreshes). The Advanced panel contains font size, contrast
and diff-marker controls, but those currently **discard on reload** — the
source marks them *"TODO: not persisted yet"*.

---

## 03 — Notifications → `03-notifications.png`

**What it shows:** four rows with Email / Push pill toggles.

**What it does:** should control which alerts you get.

**Status: not functional.** The toggles are static UI. No delivery channel is
wired up — *"TODO: make this a real multi-select once delivery channels are
defined."*

---

## 04 — Voice → `04-voice.png`

**What it shows:** a voice picker reading "Breeze".

**What it does:** should choose the voice used to read answers aloud.

**Status: not functional.** One hardcoded placeholder value.
*"TODO: make this a picker once the voice list / language list is defined."*

---

## 05 — Storage → `05-storage.png`

**What it shows:** space used by the PDF library, with a usage bar.

**What it does:** adds up the real file sizes of PDFs in your local YaniMed
Library folder.

**Status: works, with a caveat.** The disk measurement is real. The **512 MB
limit** shown against it is a hardcoded constant — nothing enforces it, so
going over does nothing. There is also no "clear search history" control yet.

---

## 06 — Personalization → `06-personalization.png`

**What it shows:** toggles for Enable memory, Reference record history,
YaniMed Voice, Library search, and Connector search.

**What it does:** should personalise how answers are produced.

**Status: not functional.** Every toggle is decorative; all are marked with
`TODO`s. **Note the misleading label:** "Library search — allow YaniMed to
search Library files" — the only search that exists is a plain filename
text filter. No question-answering search exists yet.

---

## Important: sections from the product plan that do NOT exist yet

A written tour of this app described seven settings sections. Only two of them
exist right now (Appearance, Storage). The other five are **planned but not
built** — there is no screen to photograph, so none is included here:

| Planned section | Status |
|---|---|
| Documents (PDF list, status, re-process, delete) | Not built |
| Chapter Correction (fix wrong chapter guesses) | Not built |
| Search (results used as context, hybrid search on/off) | Not built |
| AI Model (model choice, fallback order, gateway status) | Not built |
| Citations (chapter/page chips, open cited page) | Not built |

This package deliberately contains **no mock-ups**. Every image above is a
real screenshot of the running application.

---

## Where things stand

The Settings screen is currently a well-built shell. Appearance's mode switch
and Storage's disk reading work. The rest are visuals waiting on the backend,
which has only just gained its first working AI connection.