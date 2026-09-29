# Reel Cards: French reels → flashcards

A personal iPhone web app (PWA) that reads the French text on screen in an Instagram reel (or a screenshot), picks out the vocabulary, and turns it into spaced-repetition flashcards.

It's 100% free: no paid APIs, no LLMs, no accounts, no database.

## How it works

```
iPhone (PWA)                                Render free web service (Docker)
────────────                                ───────────────────────────────
pick video / screenshot ──── upload ───▶    ffmpeg: 1 frame every 2 s
   or iOS Shortcut ──────── (inbox) ───▶    Tesseract OCR (French) on each frame
                                            dedupe caption lines
                                            tokenize → drop stopwords → lemma (allait → aller)
                                            meaning + gender from bundled open dictionaries
choose words, "Add N Cards" ◀── JSON ──     (nothing is saved on the server)
cards saved in IndexedDB on the phone
Review: flip card + SM-2 (Again / Hard / Good / Easy), works offline
Library: search, edit, delete, export Anki CSV
Grammar: Practice quizzes (picked for your level) + Verbs conjugation
```

* **Server** (`server/`): plain Node.js with zero npm dependencies. Uploads go to a temp folder and are deleted as soon as they're read. Results stay in memory for 30 minutes so the phone can collect them.
* **OCR trick:** reel captions are usually white text with a dark outline, or dark text on a white box. Each frame is split into three versions (white pixels only, dark pixels only, plain grayscale) that are read in one Tesseract pass. Lines are then grouped across frames and the most frequent reading wins.
* **Conjugation** (`server/conjugate.js`, `data/conjugations.json.gz`, built by `scripts/build-conj.mjs`): the app's own free API — `GET /api/conjugate?v=allait` and `GET /api/verbs?q=man` — covering ~7,200 verbs, all simple tenses from the Grammalecte lexicon plus compound tenses built with avoir/être.
* **Grammar tab** (`public/grammar.js`, `public/grammar.json`, built from `data/grammar/*.json` by `npm run build-grammar`): two parts, **Practice** and **Verbs**.
  * **Practice:** 1,000 multiple-choice questions across 20 topics (A2: present, articles, negation, passé composé…; B1: imparfait vs passé composé, subjonctif, y/en, relative pronouns…; B2: double pronouns, lequel/auquel, conditionnel passé, connectors). Sessions are 10 questions with instant feedback and a short explanation.
  * **Recommended for you** uses the *French level* set in Profile (A1 starts at A2, C1/C2 use B2). It suggests your weakest topic at that level, otherwise the one you were working on, otherwise the next new one; once every topic at your level is mastered (80% of questions last answered right) it moves you up a level. Questions you missed come back first.
  * Runs fully on the phone and offline; answers are stored in IndexedDB. To add a topic, drop a JSON file with the same shape into `data/grammar/` and rebuild.
  * **Verbs:** the conjugation search (below).
, built by `scripts/build-data.mjs`): about 385,000 French word forms, each mapped to its dictionary form, part of speech, noun gender, and a short English meaning.
* **App** (`public/`): vanilla JS, no build step. The system font, frosted bars, a bottom tab bar, and automatic light/dark mode. A service worker caches the app so reviewing works offline.

## Run locally

Requires Node 20+, `ffmpeg`, and `tesseract` with French data (`tesseract-ocr-fra`).

```bash
npm start          # http://localhost:10000
npm test           # unit tests + end-to-end OCR test on test/fixtures/reel.mp4
```

Or run it with Docker: `docker build -t reel-cards . && docker run -p 10000:10000 reel-cards`

## Deploy (free)

`render.yaml` is a Render Blueprint for one free Docker web service. On Render: **New → Blueprint** → pick this repo → **Apply**.

It also runs unchanged on any free Docker host (for example, a Hugging Face Docker Space). Set `PORT` if the host needs a different one.

## iOS Shortcut

Open the app → **Library → Share from Instagram** for a step-by-step guide. The guide includes your personal inbox link. The Shortcut uploads a video or screenshot from the share sheet to `/api/inbox/<your code>`, and the app collects the results the next time it opens.

## Limits

* Render's free tier sleeps after 15 minutes of no traffic. The first request after that takes about 30–60 s (the app shows a "Waking up…" screen).
* The free machine is small (0.1 CPU), so OCR takes a few seconds per frame. Expect about 1–2 minutes for a 30-second reel. Screenshots are faster.
* At most 90 seconds of video (45 frames) are read per upload. The maximum upload size is 150 MB.
* OCR only reads on-screen text, not audio. Coloured text on a busy background can be missed, so a screenshot of the clearest frame helps.

## Data & licenses

* Code: MIT.
* `data/lexicon.json.gz` is derived from:
  * the **Grammalecte / Dicollecte French lexicon** v6.4.1 (Olivier R., MPL 2.0) for word forms, lemmas, and gender;
  * **English Wiktionary** French entries (CC BY-SA 4.0, via kaikki.org / wiktextract and [Vuizur/Wiktionary-Dictionaries](https://github.com/Vuizur/Wiktionary-Dictionaries)) for English meanings.

  The derived lexicon is shared under CC BY-SA 4.0.
* OCR: [Tesseract](https://github.com/tesseract-ocr/tesseract) (Apache 2.0). Frames: [FFmpeg](https://ffmpeg.org) (LGPL/GPL).
