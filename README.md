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
  "es": "el mapa",
  "key": "mapa",
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

The same sentence object, with the same `id`, is repeated on every word it belongs to. The text is duplicated on disk deliberately: it keeps the file one flat array that stays readable and hand-editable.

## Translation source

MyMemory (`api.mymemory.translated.net`), no API key, roughly 5000 characters per day. Requests go through the local server rather than the browser. If the quota runs out or the network is down the entry is marked `no translation` and gets a **retranslate** button — nothing is lost, and you can always write the gloss yourself.
