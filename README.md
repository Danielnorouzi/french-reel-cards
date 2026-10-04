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
Learn: Grammar quizzes (A1–C1, picked for your level) + Vocab decks by level + Verbs conjugation
```

* **Server** (`server/`): plain Node.js with zero npm dependencies. Uploads go to a temp folder and are deleted as soon as they're read. Results stay in memory for 30 minutes so the phone can collect them.
* **OCR trick:** reel captions are usually white text with a dark outline, or dark text on a white box. Each frame is split into three versions (white pixels only, dark pixels only, plain grayscale) that are read in one Tesseract pass. Lines are then grouped across frames and the most frequent reading wins.
* **Conjugation** (`server/conjugate.js`, `data/conjugations.json.gz`, built by `scripts/build-conj.mjs`): the app's own free API — `GET /api/conjugate?v=allait` and `GET /api/verbs?q=man` — covering ~7,200 verbs, all simple tenses from the Grammalecte lexicon plus compound tenses built with avoir/être.
* **Learn tab** (`public/grammar.js`, `public/grammar.json`, `public/vocab.json`): three parts, **Grammar**, **Vocab** and **Verbs**.
  * **Grammar:** about 4,400 multiple-choice questions across 55 topics and five levels (A1 10 topics, A2 13, B1 13, B2 11, C1 8), at least 80 questions per topic. Built from `data/grammar/*.json` by `npm run build-grammar`; titles, tile glyphs and the short rule card for each topic live in `scripts/grammar-topics.mjs`.
  * Tap a topic to read its rule card (the rule in a few lines, examples, your numbers) and pick 5, 10 or 20 questions. Each answer gets instant feedback with an explanation and a link back to the rule. The results screen lists the questions to look at again.
  * **Recommended for you** uses the *French level* set in Profile (C2 uses C1). It suggests your weakest topic at that level, otherwise the one you were working on, otherwise the next new one; once every topic at your level is mastered (80% of questions last answered right) it moves you up a level. Questions you missed come back first.
  * **Level mix** draws from every topic of a level; **Fix mistakes** brings back the questions you last got wrong.
  * **Vocab:** about 500 words to know per level (A1 to C1, 2,500 in total) in themed decks, each word with its gender, meaning and an example. Built from `data/vocab/*.txt` by `npm run build-vocab` (`--check` compares genders and spellings with the lexicon). Adding a deck creates ordinary cards in a set named after it, so they show up in Review, Library and the Anki export. Library has a shortcut to these starter decks.
  * Runs fully on the phone and offline; answers are stored in IndexedDB. To add a topic, drop a JSON file with the same shape into `data/grammar/`, add its entry to `scripts/grammar-topics.mjs` and rebuild. To add words, edit a file in `data/vocab/` and rebuild.
  * **Verbs:** the conjugation search (below).
, built by `scripts/build-data.mjs`): about 385,000 French word forms, each mapped to its dictionary form, part of speech, noun gender, and a short English meaning.
* **App** (`public/`): vanilla JS, no build step. The system font, frosted bars, a bottom tab bar, and automatic light/dark mode. A service worker caches the app so reviewing works offline.

## Backup and moving your data

Everything you make lives in the browser's storage for one address, so a new phone, a new browser, or a move from one address to another (say Render to your own server) starts empty. **Profile → Back Up This Phone** saves one file with all of it:

* every card with its review schedule (ease, interval, due date), and your sets
* the activity log behind the streak, heatmap and all-time stats
* grammar progress, your profile, and settings such as review direction

**Profile → Restore from a Backup** reads the file on the other side. It shows what is in the file next to what is on the phone, then either **merges** (adds new words, keeps whichever copy of a shared word was reviewed more recently, joins sets with the same name, never counts a day or a grammar answer twice) or **replaces** everything. The last restore can be undone from the same screen.

A backup can be locked with a password: AES-256-GCM with a key from PBKDF2-SHA256 (600,000 rounds), done in the browser. A forgotten password cannot be recovered. Password locking needs an https address (or localhost). The Shortcut inbox code is not in a backup, because it belongs to one phone and one address. Code: `public/backup.js`; tests: `test/backup.test.js`.

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
