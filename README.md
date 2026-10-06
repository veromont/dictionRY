# Spanish vocab

A local web app for logging Spanish words while learning them. Runs on your own machine; the data lives in a plain JSON file you own.

Open it at **http://localhost:8787**

## How it works

- `server.js` — a small Node server (no dependencies, nothing to install). Serves the page, reads and writes the data file, and proxies translation requests.
- `public/index.html` — the screen: markup, styles, and everything you click.
- `public/store.js` — the data: words, sentences, the links between them, loading and saving.
- `public/text.js` — small text helpers (ignoring case and accents, splitting sentences into words).
- `lib/dictionary.js` — looks words up in the dictionary; `tools/build-dictionary.js` builds it (see **Dictionary**).
- `data/dictionary.sqlite` — the dictionary: Spanish from English Wiktionary. Rebuildable, not your data.
- `data/vocab.json` — **the data.** Plain, readable JSON. Edit it by hand, copy it, commit it, back it up.
- `data/vocab.v1.json` — your file as it was before words and sentences were split apart. Kept for good; nothing writes to it.
- `data/backups/` — a snapshot taken before every write. The 20 most recent are kept.
- `test/run.js` — checks the dictionary lookups, the linking and the conversion, using `test/fixtures/dict-sample.jsonl` (a few real Wiktionary entries). Run `node test/run.js`; it only reads `data/`, never writes.
- `start-hidden.vbs` — launches the server with no console window.

The server starts automatically at logon via a shortcut in the Windows Startup folder (`Spanish vocab server.lnk`). Delete that shortcut to stop it starting.

## Using it

Type a word, press Enter. The app looks it up in the dictionary first:

- **One clear answer** — it's saved under its dictionary headword, with its meanings. Type `celosa` and you get `celoso`, and the notice says `celosa` is its feminine form, with **keep celosa** beside it if you meant the literal word. Verbs are saved as the infinitive, and nouns keep the article you typed, corrected if it was wrong (`los ganancias` → `la ganancia`).
- **Several answers** — nothing is saved until you pick one. `sueño` offers the noun *(dream, sleep)* and the verb `soñar`, because it's also "I dream".
- **A spelling slip** — *did you mean* `cómoda` for `comoda`, or `placer` for `palcer`.
- **Nothing** — it's saved as typed and translated by machine, as before, marked with an `auto` badge.

Rare verb forms aren't offered when a common reading exists: `cosa` is also a subjunctive of *coser*, but you'll never be asked about it.

The meaning shown on a word is your own gloss if you wrote one, otherwise the dictionary's, otherwise the machine translation. Press **edit** to write your own; nothing ever overwrites it.

Adding a word you already have does not create a duplicate: typing `celosas` next month opens `celoso`.

**Check against dictionary** (bottom of the page) goes through every saved word. It fills in meanings, gender, forms and verb tables straight away, since that only adds information and never touches your own gloss, notes or corrected tables. Anything that would rename or merge a word goes on a review list, one row each, which you accept or skip: respellings (`comoda → cómoda`), typos (`el palcer → placer`, merging into the `placer` you already have), headwords (`maniobras → maniobra`), wrong articles. Skipped words aren't asked about again.

## Verbs

Expand a verb and its conjugation sits above its sentences. The present tense shows first, with the gerund and past participle; **more tenses** opens the preterite, imperfect, future, conditional, present and imperfect subjunctive, and the imperative. All of them come from Wiktionary, so irregular verbs are right: `hacer → hice, hizo, hecho`.

```
PRESENT  dictionary
yo       hago     nosotros  hacemos
tú       haces    vosotros  hacéis
él/ella  hace     ellos     hacen
gerund   haciendo participle hecho
```

Each table can be corrected on its own with **edit**; once you do, it's marked `yours` and the dictionary never overwrites it. **reset** puts the dictionary's version back, after asking. Tables marked `irregular` or `generated` come from the rules engine the app used before the dictionary; **Check against dictionary** replaces them.

Sentences match through every stored form, in every tense: `Ayer hice la comida` reaches `hacer` on its own, and the matched form is highlighted. Nouns and adjectives link through their real plurals and feminines (`cosas`, `celosas`). Words the dictionary doesn't know fall back to guessing plurals.

`ñ` counts as its own letter: `sueño` is never mistaken for `sueno`, a form of `sonar`.

## Example sentences

A word on its own is the weakest kind of flashcard, so words and the sentences you met them in live side by side and link to each other.

Words and sentences are **separate things**. A sentence exists once, however many words it belongs to, and it stays when a word is deleted. The `sentences` tab lists all of them; opening a word shows the ones linked to it.

**Links are worked out from the text, all the time.** A sentence links to every saved word it contains — including plurals (`cosas` → `cosa`) and any stored verb form (`hago` → `hacer`, `veremos` → `ver`). Because nothing is frozen at the moment you add a sentence:

- save a new word and every older sentence containing it links up immediately
- edit a sentence and its links follow the new text
- correct a verb form and sentences using that form attach to the verb

The words found are highlighted inside the sentence.

**You can overrule the matcher either way.** Each linked word shows as a chip with an **×** — press it and that word stays unlinked from that sentence, even though it's in the text. **+ word** on a sentence pins a word the matcher can't see, like a typo or a preterite form (`hice` → `hacer`). Pinned words show in italics. Adding a sentence from a word's own row pins it to that word if the text alone wouldn't.

**Edit** on a sentence changes its text and source in place. Pasting a sentence you already have — even with different capitals or without the full stop — opens the one you have instead of making a copy. A sentence with none of your words in it is still saved, and links up as you add them.

Sentences are never machine-translated. They are context to work out, and translating every one would burn the free quota in a day.

Search filters as you type across the Spanish word, both translations, your notes, and your sentences — accents optional. Press `/` anywhere to jump to the search box.

The footer shows whether your changes have reached the file: `saved`, `saving…`, or a red `unsaved — retrying`. If the server is not running, the app holds your changes in the browser and keeps retrying, then saves them as soon as the server is back.

## Running it by hand

```
node D:\agent\spanish-vocab\server.js
```

Add `--lan` to reach it from your phone on the same Wi-Fi at `http://<your-pc-ip>:8787`. Without that flag the server only listens on localhost.

To stop the background instance, find and kill it:

```
netstat -ano | findstr :8787
taskkill /PID <pid> /F
```

## Data shape

One file, three lists — like three tables in a database:

```json
{
  "version": 2,
  "words": [
    {
      "id": "uuid",
      "es": "hacer",
      "key": "hacer",
      "pos": "verb",
      "dict": { "headword": "hacer", "pos": "verb", "senses": ["to do, perform, execute, carry out", "to make"] },
      "conj": {
        "gerund": "haciendo",
        "participle": "hecho",
        "present": { "source": "dictionary", "forms": ["hago", "haces", "hace", "hacemos", "hacéis", "hacen"] },
        "preterite": { "source": "dictionary", "forms": ["hice", "hiciste", "hizo", "hicimos", "hicisteis", "hicieron"] },
        "…": "imperfect, future, conditional, subjunctive, imperfectSubjunctive, imperative"
      },
      "auto": "do",
      "autoState": "ok",
      "gloss": "",
      "notes": "",
      "createdAt": 1789587435481,
      "updatedAt": 1789587447527
    }
  ],
  "sentences": [
    { "id": "uuid", "text": "No puedo hacer nada.", "source": "podcast ep. 12", "createdAt": 1789591190464, "updatedAt": 1789591190464 }
  ],
  "links": [
    { "wordId": "uuid", "sentenceId": "uuid", "kind": "manual" },
    { "wordId": "uuid", "sentenceId": "uuid", "kind": "blocked" }
  ]
}
```

`links` holds **only your decisions** — words you pinned (`manual`) and matches you rejected (`blocked`). The links you see are:

```
(matched from the text  +  manual)  −  blocked
```

The matched ones are never stored, so they can never go stale. Rows point at ids, so renaming a word or editing a sentence doesn't break them.

`dict` is the copy of what the dictionary said when the word was saved. Nouns also get `gender` (`m`, `f` or `mf`), and nouns and adjectives get `forms` (plurals, feminines). `conj` is only present on verbs, and is plain enough to fix by hand. To add a sentence by hand, append it to `sentences` with any unique `id`; it links itself on the next load.

## Translation source

Meanings come from **Wiktionary** (English edition), via the extraction published at kaikki.org. Wiktionary text is licensed CC BY-SA.

For phrases and anything the dictionary doesn't have, MyMemory (`api.mymemory.translated.net`) fills in, with no API key and roughly 5000 characters per day. Requests go through the local server. If the quota runs out or the network is down the entry is marked `no translation` and gets a **retranslate** button.

## Dictionary

The dictionary is built once from Wiktionary's full data dump and stored in `data/dictionary.sqlite`, a normal SQLite file you can open in DBeaver or any SQLite tool:

```
entries(word, pos, gender, senses, forms, conj)   -- one row per headword and part of speech
forms  (form, lemma, pos, tags)                   -- every inflected form → its headword
```

For example, `SELECT * FROM forms WHERE form = 'hice'` shows it is the yo preterite of `hacer`.

To rebuild it, for example to pick up Wiktionary's weekly updates:

1. Download `https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz` (about 2.9 GB) into `dictionary-source/`.
2. Run `node tools/build-dictionary.js dictionary-source/raw-wiktextract-data.jsonl.gz`. This takes a while and prints its progress.
3. Restart the server so it opens the new file. On Windows the build can't replace a file the running server has open; if it says so, stop the server, rename `dictionary.sqlite.tmp` to `dictionary.sqlite`, and start it again.

Your words keep their own copy of what the dictionary said when they were saved, so a rebuild changes nothing until you run **Check against dictionary** again. The download can be deleted after the build.

Without the dictionary file the app still works: words are saved as typed and translated by machine.
