# Spanish vocab

A local web app for logging Spanish words while learning them. Runs on your own machine; the data lives in a plain JSON file you own.

Open it at **http://localhost:8787**

## How it works

- `server.js` — a small Node server (no dependencies, nothing to install). Serves the page, reads and writes the data file, and proxies translation requests.
- `public/index.html` — the entire app: markup, styles, and script in one file.
- `data/vocab.json` — **the data.** Plain, readable JSON. Edit it by hand, copy it, commit it, back it up.
- `data/backups/` — a snapshot taken before every write. The 20 most recent are kept.
- `start-hidden.vbs` — launches the server with no console window.

The server starts automatically at logon via a shortcut in the Windows Startup folder (`Spanish vocab server.lnk`). Delete that shortcut to stop it starting.

## Using it

Type a word, press Enter. The row appears immediately and an English translation fills in a moment later, marked with an `auto` badge.

That automatic translation is a starting point, not the truth. Machine translation is regularly wrong on slang and idiom, so press **edit** and write your own gloss. Your gloss then replaces the automatic one everywhere, the badge disappears, and nothing ever overwrites it — the automatic text stays cached underneath and is only refetched if you press **retranslate**.

Adding a word you already have does not create a duplicate. The app recognises it, tells you, and opens the existing entry for editing instead. Matching ignores capitals, accents, and a leading article, so `el mapa`, `Mapa`, and `MAPÁ` are all the same word.

## Verbs

A word is saved under its **infinitive**. Type `espero` and the entry becomes `esperar`, with its present-tense forms attached; the notice says what happened and leaves a one-click **keep espero** next to it if you meant the literal word.

Expand a verb and its forms sit above the sentences, one block per tense — present, future, conditional and imperfect:

```
PRESENT  irregular                    FUTURE  irregular
yo       hago     nosotros  hacemos   yo      haré     nosotros  haremos
tú       haces    vosotros  hacéis    tú      harás    vosotros  haréis
él/ella  hace     ellos     hacen     él/ella hará     ellos     harán
gerund   haciendo
```

Each tense is corrected and rebuilt on its own — fixing the future leaves the present alone. The badge says where that tense's forms came from. `irregular` means they were looked up in the app's own table of irregular and stem-changing verbs. `generated` means the regular rules produced them, and an irregularity the app does not know about would make them wrong. `yours` means you corrected them — press **edit**, fix what is wrong, and nothing regenerates over it afterwards. **regenerate** rebuilds that tense from the rules and asks first if it would throw away your corrections.

Sentences match through every stored form, so `No puedo hacer nada` reaches `poder` as well as `hacer`, and `Ya veremos` reaches `ver`. The matched form is highlighted. Correcting a form immediately changes what attaches to it.

A word that turns out to be a form of a verb you already saved is folded into it — `veremos` disappears into `ver`, carrying its sentences, and its own translation is kept as a note. The notice names every fold and leaves a **keep** button beside it.

Every word also carries a **part of speech** — verb, noun, adjective, phrase or other — guessed when it is saved and changeable in the editor. Setting a word to `verb` builds its forms; setting it to anything else drops them.

### What it covers

Present, future, conditional and imperfect. **Not the preterite**: `Ayer hice la comida` will not find `hacer`, and typing `hice` will not resolve to it either. That tense has dozens of irregular stems, which is a different size of job. Adding a sentence from the verb's own row still attaches it, so nothing is out of reach — it just is not automatic.

Two things stop a noun being mistaken for a verb form. A word you type with its article — `el sueño`, `la meta` — is taken at its word and never resolved, because the article is you saying it is a noun. And `ñ` counts as its own letter here, so `sueño` (dream) is not treated as `sueno`, the yo-form of `sonar`; `soñar` and `sonar` stay two different verbs.

Resolving a form to its infinitive only happens for verbs on the app's list of about 500 common ones. This is deliberate: every Spanish noun in `-a` or `-o` looks like a conjugated verb, so without the list `mapa` would become `mapar` and `verano` would become `veranar`. Words that are far more often a noun or a function word — `nada`, `trabajo`, `recuerdo`, `cuenta`, `para`, `como` — are never converted even though they are real verb forms. A verb missing from the list is simply left alone: type the infinitive yourself and set the part of speech, and everything else works as usual.

## Example sentences

A word on its own is the weakest kind of flashcard, so every word can carry the sentences you met it in.

Click a word (or its count chip) to expand it, type the sentence, press Enter. The `sentences` tab at the top does the same thing from one box, and lists everything you have collected.

**A sentence attaches to every saved word it contains, not just the one you are looking at.** Save *"En verano y primavera hago cosas hermosas"* and it lands on `verano`, `primavera`, `cosa`, `cosas`, and `hermosa` at once — the app tells you which. The words it recognised are highlighted inside the sentence, so you can see what it caught.

Matching tolerates plurals (`mapa` catches `mapas`, `ciudad` catches `ciudades`) but **not conjugation** — `hacer` is not found inside `hago`. That is why a sentence added from a word's own row always attaches to that word, whether or not the matcher saw it. Adding from the `sentences` tab needs at least one recognised word, since a sentence with no word has nowhere to live.

A sentence is stored on each of its words with the same `id`, which is what links them. Deleting it from one word removes it from all of them. Deleting a *word* takes its own sentences with it; ones shared with other words stay on those.

Sentences are never machine-translated. They are context to work out, and translating every one would burn the free quota in a day.

To add one by hand in an editor, a bare string is enough — the app upgrades it on load:

```json
"examples": ["En otoño las hojas caen."]
```

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

```json
{
  "id": "uuid",
  "es": "hacer",
  "key": "hacer",
  "pos": "verb",
  "conj": {
    "gerund": "haciendo",
    "present": { "source": "irregular", "forms": ["hago", "haces", "hace", "hacemos", "hacéis", "hacen"] },
    "future": { "source": "irregular", "forms": ["haré", "harás", "hará", "haremos", "haréis", "harán"] },
    "conditional": { "source": "irregular", "forms": ["haría", "harías", "haría", "haríamos", "haríais", "harían"] },
    "imperfect": { "source": "generated", "forms": ["hacía", "hacías", "hacía", "hacíamos", "hacíais", "hacían"] }
  },
  "auto": "Map",
  "autoState": "ok",
  "gloss": "map (the paper kind)",
  "examples": [
    { "id": "uuid", "text": "En verano hago cosas hermosas.", "source": "podcast ep. 12", "addedAt": 1789591190464 }
  ],
  "notes": "",
  "createdAt": 1789587435481,
  "updatedAt": 1789587447527
}
```

`conj` is only present on verbs, and is plain enough to fix by hand. The same sentence object, with the same `id`, is repeated on every word it belongs to. The text is duplicated on disk deliberately: it keeps the file one flat array that stays readable and hand-editable.

## Translation source

MyMemory (`api.mymemory.translated.net`), no API key, roughly 5000 characters per day. Requests go through the local server rather than the browser. If the quota runs out or the network is down the entry is marked `no translation` and gets a **retranslate** button — nothing is lost, and you can always write the gloss yourself.
