// Run with:  node test/run.js
// Builds a small dictionary from test/fixtures/dict-sample.jsonl (real Wiktionary entries), then
// checks the dictionary lookups, the page's data model and linking, and the v1 conversion.
// Never writes to data/ — the real vocabulary file is only read.

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { build } = require("../tools/build-dictionary");
const { openDictionary } = require("../lib/dictionary");

const root = path.join(__dirname, "..");

let failures = 0;
let passes = 0;
function check(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) passes++;
	else {
		failures++;
		console.log("FAIL  " + label + "\n      got  " + JSON.stringify(got) + "\n      want " + JSON.stringify(want));
	}
}
function section(name) { console.log("\n" + name); }

(async function main() {
	// --- the dictionary, built from real entries ---------------------------------------------

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocab-test-"));
	const dictFile = path.join(tmpDir, "dictionary.sqlite");
	await build(path.join(__dirname, "fixtures", "dict-sample.jsonl"), dictFile, () => {});
	const dictionary = openDictionary(dictFile);
	const look = q => dictionary.lookup(q).candidates;
	const heads = q => look(q).map(c => c.display + " (" + c.pos + ", " + c.via + ")");

	section("dictionary lookups");
	check("sueño is the noun and a form of soñar", heads("sueño"), ["sueño (noun, headword)", "soñar (verb, form)"]);
	check("an article means the noun only", heads("el sueño"), ["el sueño (noun, headword)"]);
	check("hago → hacer", heads("hago"), ["hacer (verb, form)"]);
	check("hice → hacer", heads("hice"), ["hacer (verb, form)"]);
	check("celosa → celoso", heads("celosa"), ["celoso (adjective, form)"]);
	check("maniobras → maniobra", heads("maniobras").slice(0, 1), ["maniobra (noun, form)"]);
	check("rare subjunctive of coser not offered for cosa", heads("cosa"), ["cosa (noun, headword)"]);
	check("comoda → spelling suggestions", look("comoda").map(c => c.display).sort(), ["cómoda", "cómodo"]);
	check("palcer → placer", look("palcer").map(c => c.display).slice(0, 1), ["placer"]);
	check("los ganancias → la ganancia", look("los ganancias").map(c => c.display + " / " + (c.genderNote || "")), ["la ganancia / ganancia is feminine"]);
	check("sueño's meanings merged from both etymologies", look("el sueño")[0].senses.some(s => /dream/.test(s)) && look("el sueño")[0].senses.some(s => /sleep/.test(s)), true);
	check("noun gender", look("la cosa")[0].gender, "f");

	const hacer = look("hacer").find(c => c.pos === "verb");
	check("hacer present", hacer.conj.present.forms.join("/"), "hago/haces/hace/hacemos/hacéis/hacen");
	check("hacer preterite", hacer.conj.preterite.forms.join("/"), "hice/hiciste/hizo/hicimos/hicisteis/hicieron");
	check("hacer imperative has no yo", hacer.conj.imperative.forms[0], "");
	check("hacer gerund and participle", [hacer.conj.gerund, hacer.conj.participle], ["haciendo", "hecho"]);
	const ser = look("ser").find(c => c.pos === "verb");
	check("ser imperfect", ser.conj.imperfect.forms.join("/"), "era/eras/era/éramos/erais/eran");
	check("ir preterite", look("ir").find(c => c.pos === "verb").conj.preterite.forms.join("/"), "fui/fuiste/fue/fuimos/fuisteis/fueron");
	check("soñar keeps ñ", look("soñar").find(c => c.pos === "verb").conj.present.forms[0], "sueño");
	check("unknown word gives nothing", look("xqzv"), []);

	// --- the page's data model, with words filled from that dictionary ---------------------------

	const ctx = vm.createContext({ crypto: globalThis.crypto, console: console });
	for (const file of ["public/text.js", "public/store.js"]) {
		vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
	}
	const js = code => vm.runInContext(code, ctx);
	ctx.__candidates = look;
	js(`
		globalThis.__use = parsed => { db = loadAny(parsed).db; relink(); return db; };
		globalThis.__word = (query, id) => {
			const c = __candidates(query)[0];
			const word = { id: id, es: c.display, key: normKey(c.display), gloss: "", pos: "", notes: "" };
			applyDictionary(word, c);
			db.words.push(word);
			return word;
		};
	`);

	section("linking");
	js(`__use({ words: [], sentences: [], links: [] })`);
	js(`
		__word("hacer", "w-hacer"); __word("el sueño", "w-sueno"); __word("celoso", "w-celoso"); __word("cosa", "w-cosa");
		createSentence("Ayer hice la comida.", "");
		createSentence("Tuve un sueño con cosas celosas.", "");
		createSentence("Mañana lo haremos.", "");
		relink();
	`);
	const S = text => js(`db.sentences.find(s => s.text.startsWith(${JSON.stringify(text)})).id`);
	const wordsOf = text => js(`linkedWords(${JSON.stringify(S(text))}).map(w => w.es).sort()`);
	check("preterite links automatically (hice → hacer)", wordsOf("Ayer"), ["hacer"]);
	check("dictionary plurals and feminines link", wordsOf("Tuve"), ["celoso", "cosa", "el sueño"]);
	check("future form links", wordsOf("Mañana"), ["hacer"]);
	check("no manual rows needed", js(`db.links.length`), 0);
	check("meaning comes from the dictionary", js(`meaningOf(db.words.find(w => w.id === "w-sueno")).from`), "dictionary");
	js(`db.words.find(w => w.id === "w-sueno").gloss = "dream (mine)";`);
	check("your gloss wins", js(`meaningOf(db.words.find(w => w.id === "w-sueno")).text`), "dream (mine)");

	js(`const w = db.words.find(x => x.id === "w-hacer"); w.conj.present = { source: "yours", forms: ["x", "", "", "", "", ""] }; applyDictionary(w, __candidates("hacer").find(c => c.pos === "verb"));`);
	check("a corrected table survives re-applying the dictionary", js(`db.words.find(w => w.id === "w-hacer").conj.present.forms[0]`), "x");
	check("other tables are refreshed", js(`db.words.find(w => w.id === "w-hacer").conj.preterite.source`), "dictionary");

	js(`const cosas = { id: "w-cosas", es: "cosas", key: "cosas", gloss: "stuff", pos: "other", notes: "" }; db.words.push(cosas);
		const pinned = createSentence("Nada más.", ""); relink();
		pinLink(pinned.id, "w-cosas"); relink();
		mergeWordInto(cosas, db.words.find(w => w.id === "w-cosa")); relink();`);
	check("merging moves pinned links to the target", wordsOf("Nada más"), ["cosa"]);
	check("merging keeps the other gloss", js(`db.words.find(w => w.id === "w-cosa").gloss`), "stuff");
	check("merged word is gone", js(`db.words.some(w => w.id === "w-cosas")`), false);

	check("resolveWord finds a word by any stored form", js(`resolveWord("hicieron").es`), "hacer");
	check("resolveWord finds nothing for an unsaved word", js(`resolveWord("vivir")`), null);

	js(`editSentence(db.sentences.find(s => s.text.startsWith("Ayer")), "Ayer comí.", ""); relink();`);
	check("editing a sentence drops a link", wordsOf("Ayer"), []);
	js(`unpinLink(${JSON.stringify(S("Mañana"))}, "w-hacer"); relink();`);
	check("blocked beats a match", wordsOf("Mañana"), []);
	js(`pinLink(${JSON.stringify(S("Mañana"))}, "w-hacer"); relink();`);
	check("re-linking a blocked match just removes the block", js(`db.links.filter(r => r.kind === "blocked").length`), 0);
	js(`removeWord("w-celoso"); relink();`);
	check("deleting a word keeps its sentences", js(`db.sentences.length`), 4);
	check("duplicate sentence found despite case and full stop", js(`Boolean(findSentenceByText("mañana lo haremos"))`), true);

	section("words without dictionary data");
	js(`__use({ words: [{ id: "m", es: "mapa", key: "mapa", pos: "noun" }], sentences: [], links: [] })`);
	js(`createSentence("Dos mapas viejos.", ""); relink();`);
	check("plural guess still works for words the dictionary never filled", js(`linkedWords(db.sentences[0].id).map(w => w.es)`), ["mapa"]);

	// --- learning: states, active days, flashcards ----------------------------------------------

	section("learning");
	// A fake clock: day 0 is a fixed date, and "active" days are the ones something was added on.
	const DAY = 86400000;
	const base = Date.UTC(2026, 0, 10, 12);
	const goTo = n => js(`Date.now = () => ${base + n * DAY};`);
	goTo(0);
	js(`__use({ words: [], sentences: [], links: [], activeDays: [] })`);
	js(`
		globalThis.__add = (query, id) => { markActiveDay(); const w = __word(query, id); w.state = "new"; w.touched = today(); return w; };
		__add("hacer", "w-hacer"); __add("cosa", "w-cosa");
		relinkAndStartLearning();
	`);
	check("adding a word marks the day active", js(`today()`), 1);
	check("a word with no sentence is new", js(`wordState(db.words.find(w => w.id === "w-hacer"))`), "new");

	js(`createSentence("Ayer hice una cosa.", ""); relinkAndStartLearning();`);
	check("its first sentence starts learning", js(`db.words.filter(w => w.state === "learning").map(w => w.es).sort()`), ["cosa", "hacer"]);
	check("a learning word is due at once", js(`dueWords("learning").length`), 2);

	js(`moveWord(db.words.find(w => w.id === "w-cosa"), "new"); createSentence("Otra cosa más.", ""); relinkAndStartLearning();`);
	check("moved back to new by hand, it stays new when more sentences arrive", js(`db.words.find(w => w.id === "w-cosa").state`), "new");

	js(`__add("el sueño", "w-sueno"); createSentence("Tuve un sueño.", ""); relinkAndStartLearning();`);
	check("a new word gaining a sentence the same day starts learning", js(`db.words.find(w => w.id === "w-sueno").state`), "learning");

	// Archiving counts active days only: calendar days with nothing added don't move it.
	js(`moveWord(db.words.find(w => w.id === "w-sueno"), "new");`);
	goTo(30);
	check("thirty idle calendar days don't archive anything", js(`wordState(db.words.find(w => w.id === "w-sueno"))`), "new");
	for (let n = 31; n < 38; n++) { goTo(n); js(`markActiveDay();`); }
	check("seven active days untouched archive a new word", js(`wordState(db.words.find(w => w.id === "w-sueno"))`), "archived");
	check("opening it brings it back", js(`touchWord(db.words.find(w => w.id === "w-sueno")) && wordState(db.words.find(w => w.id === "w-sueno"))`), "new");

	// Spaced repetition on the same clock.
	js(`globalThis.__h = db.words.find(w => w.id === "w-hacer"); startLearning(__h);`);
	check("first correct answer", js(`[grade(__h, true), __h.review.streak, __h.review.due - today()]`), ["knew", 1, 1]);
	check("more practice the same active day changes nothing", js(`[grade(__h, true), __h.review.streak]`), ["knew", 1]);
	check("not due the next calendar day if the site was not used", (goTo(39), js(`dueWords("learning").some(w => w === __h)`)), false);
	js(`markActiveDay();`);
	check("due on the next active day", js(`dueWords("learning").some(w => w === __h)`), true);
	check("second correct answer, next gap 3", js(`[grade(__h, true), __h.review.streak, __h.review.due - today()]`), ["knew", 2, 3]);
	goTo(40); js(`markActiveDay();`);
	check("practice counts: an early correct answer on a new active day", js(`grade(__h, true)`), "learned");
	check("three correct days in a row: learned", js(`__h.state`), "learned");
	check("a miss drops a learned word back to learning", js(`[grade(__h, false), __h.state, __h.review.step, __h.review.due === today()]`), ["lapsed", "learning", 0, true]);

	js(`moveWord(__h, "learned");`);
	check("marked learned by hand: next review 21 active days out", js(`__h.review.due - today()`), 21);

	// Flashcards.
	js(`startLearning(__h);`);
	const cardTypes = js(`[0, 1, 2, 3].map(() => { const c = cardFor(__h); __h.review.next++; return c.type; })`);
	check("cards cycle through meaning, Spanish and fill-the-gap", cardTypes, ["meaning", "spanish", "cloze", "meaning"]);
	js(`__h.review.next = 2;`);
	check("fill-the-gap hides the word's form in its own sentence", js(`(c => c.cloze.before + "___" + c.cloze.after + " | " + c.cloze.answer)(cardFor(__h))`), "Ayer ___ una cosa. | hice");
	js(`const lone = __add("celoso", "w-celoso"); startLearning(lone);`);
	check("no sentence with the word: no fill-the-gap card", js(`[0, 1, 2].map(i => { const w = db.words.find(x => x.id === "w-celoso"); w.review.next = i; return cardFor(w).type; })`), ["meaning", "spanish", "meaning"]);

	section("confusing word groups");
	js(`__use({ words: [], sentences: [], links: [], activeDays: [] }); markActiveDay();
		globalThis.__w = es => db.words.find(w => w.es === es);
		for (const es of ["llegar", "llevar", "lavar", "llamar", "llenar", "leer"]) db.words.push({ id: "w-" + es, es: es, key: es, gloss: "mean " + es, pos: "verb", notes: "", state: "new", touched: today() });
		globalThis.__pair = createGroup([__w("llegar"), __w("llevar")], "g vs v");
		relink();`);
	check("a group finds its words", js(`groupWords(__pair).map(w => w.es)`), ["llegar", "llevar"]);
	check("the words list the group, the group lists no words", js(`[__w("llegar").groupIds[0] === __pair.id, "wordIds" in __pair]`), [true, false]);
	check("joining moves a new word to learning", js(`[__w("llegar").state, __w("llegar").review.due === today(), "touched" in __w("llegar")]`), ["learning", true, false]);
	check("same words find the group", js(`findGroupWith([__w("llevar"), __w("llegar")]) === __pair`), true);
	check("different words don't", js(`findGroupWith([__w("llevar"), __w("lavar")])`), null);

	js(`__w("lavar").touched = today() - ARCHIVE_AFTER;`);
	check("before joining it is archived", js(`wordState(__w("lavar"))`), "archived");
	js(`globalThis.__other = createGroup([__w("llevar"), __w("lavar")], ""); relink();`);
	check("joining moves an archived word to learning", js(`wordState(__w("lavar"))`), "learning");
	check("a word can be in two groups", js(`groupsOf(__w("llevar")).length`), 2);
	check("vs lists every word it shares a group with", js(`__w("llevar").groupIds.length`), 2);

	js(`startLearning(__w("llamar")); grade(__w("llamar"), true); globalThis.__before = JSON.stringify(__w("llamar").review);
		addToGroup(__other, __w("llamar")); relink();`);
	check("a learning word keeps its progress when it joins", js(`JSON.stringify(__w("llamar").review) === __before`), true);
	js(`moveWord(__w("llenar"), "learned"); globalThis.__before = JSON.stringify(__w("llenar").review);
		addToGroup(__other, __w("llenar")); relink();`);
	check("a learned word stays learned when it joins", js(`[__w("llenar").state, JSON.stringify(__w("llenar").review) === __before]`), ["learned", true]);

	js(`removeFromGroup(__other, __w("llamar")); relink();`);
	check("removing from a larger group keeps the group", js(`[groupWords(__other).map(w => w.es), "groupIds" in __w("llamar")]`), [["lavar", "llenar", "llevar"], false]);

	js(`__use(JSON.parse(snapshot())); __pair = db.groups.find(g => g.note === "g vs v"); __other = db.groups.find(g => g.note === "");`);
	check("groups survive a save and reload", js(`[db.groups.length, groupWords(__pair).map(w => w.es)]`), [2, ["llegar", "llevar"]]);

	// Flashcards for grouped words.
	js(`globalThis.__types = word => [0, 1, 2, 3].map(i => { word.review.next = i; return cardFor(word).type; });`);
	check("a grouped word gets a which card", js(`__types(__w("llegar"))`), ["meaning", "spanish", "which", "meaning"]);
	js(`startLearning(__w("leer"));`);
	check("an ungrouped word never does", js(`__types(__w("leer"))`), ["meaning", "spanish", "meaning", "spanish"]);
	js(`__w("llegar").review.next = 2;`);
	check("its choices are the group's words", js(`cardFor(__w("llegar")).choices.map(w => w.es).sort()`), ["llegar", "llevar"]);
	js(`globalThis.__saved = __w("llegar").gloss; __w("llegar").gloss = "";`);
	check("no meaning and no sentence, no card at all", js(`cardFor(__w("llegar"))`), null);
	js(`__w("llegar").gloss = __saved;`);

	goTo(50); js(`markActiveDay();`);
	js(`for (const es of ["llegar", "llevar", "lavar"]) grade(__w(es), true);
		moveWord(__w("lavar"), "new");`);
	check("a right answer moves up only the studied word", js(`[grade(__w("leer"), true), __w("leer").review.streak, __w("llegar").review.streak]`), ["knew", 1, 1]);
	js(`grade(__w("llevar"), false);`);
	check("a miss on another card resets only that word", js(`[__w("llevar").review.streak, __w("llegar").review.streak]`), [0, 1]);

	goTo(51); js(`markActiveDay(); grade(__w("llevar"), true);`);
	js(`globalThis.__reset = resetGroup(__other, __w("llevar")).map(r => [r.word.es, r.lapsed]);`);
	check("a which miss resets the group's other words, and a learned one drops", js(`__reset`), [["llenar", true]]);
	check("a word moved back to new is left alone", js(`[__w("lavar").state, "review" in __w("lavar")]`), ["new", false]);
	check("that learned word is learning again, from the start", js(`[__w("llenar").state, __w("llenar").review.streak, __w("llenar").review.due === today()]`), ["learning", 0, true]);
	check("the word that was answered is not touched by the group reset", js(`__w("llevar").review.streak`), 1);
	check("a word only in another group is not reset", js(`__w("llegar").review.streak`), 1);

	js(`globalThis.__file = JSON.parse(snapshot());`);
	js(`removeWord("w-llegar"); relink();`);
	check("deleting a word from a two-word group deletes the group", js(`[db.groups.includes(__pair), __w("llevar").groupIds.includes(__pair.id)]`), [false, false]);

	js(`__use({ words: [], sentences: [], links: [], activeDays: [] });
		db.words.push({ id: "own", es: "llevar", key: "llevar", gloss: "", pos: "verb", notes: "", state: "learning", review: { step: 0, due: 0, streak: 0, lastCorrect: null, next: 0 } });
		mergeDb(loadAny(__file).db); relink();`);
	check("import brings the groups", js(`db.groups.length`), 2);
	check("import gives an already-saved word its groups", js(`[__w("llevar").id, groupsOf(__w("llevar")).length]`), ["own", 2]);
	js(`mergeDb(loadAny(__file).db); relink();`);
	check("importing the same file twice adds no duplicates", js(`[db.groups.length, __w("llevar").groupIds.length]`), [2, 2]);

	js(`db.words.push({ id: "typo", es: "llebar", key: "llebar", gloss: "", pos: "other", notes: "", groupIds: [db.groups[0].id] });
		mergeWordInto(__w("llebar"), __w("leer")); relink();`);
	check("merging carries group membership over", js(`__w("leer").groupIds.includes(db.groups[0].id)`), true);

	js(`__use({ words: [{ id: "a", es: "mapa", key: "mapa", pos: "noun" }], sentences: [], links: [] })`);
	check("an older file loads with no groups", js(`db.groups`), []);

	section("first load of an older file");
	js(`__use({ words: [
		{ id: "a", es: "mapa", key: "mapa", pos: "noun", createdAt: ${base} },
		{ id: "b", es: "cosa", key: "cosa", pos: "noun", createdAt: ${base + 5 * DAY} }
	], sentences: [{ id: "s", text: "Una cosa.", createdAt: ${base + 9 * DAY} }], links: [] })`);
	check("active days rebuilt from when things were added", js(`db.activeDays.length`), 3);
	check("migration reports a change", js(`initLearning()`), true);
	check("word with a sentence → learning, without → new", js(`db.words.map(w => w.es + ":" + w.state)`), ["mapa:new", "cosa:learning"]);
	check("a new word's clock counts from the day it was added", js(`db.words[0].touched`), 1);
	check("second run changes nothing", js(`initLearning()`), false);

	// --- importing an old export (v1 format) ---------------------------------------------------

	section("v1 import");
	const fixture = [
		{ id: "a", es: "cena", key: "cena", pos: "noun", gloss: "dinner", examples: [{ id: "s1", text: "Hago la cena.", source: "", addedAt: 1 }] },
		{ id: "b", es: "mapa", key: "mapa", pos: "noun", gloss: "", examples: [{ id: "s1", text: "Hago la cena.", source: "", addedAt: 1 }, "Es un mapa."] },
		{ id: "c", es: "el palcer", key: "palcer", pos: "noun", gloss: "", examples: [{ id: "s2", text: "Es todo un placer.", source: "", addedAt: 2 }] }
	];
	const conv = js(`JSON.parse(JSON.stringify(fromV1(${JSON.stringify(fixture)}).db))`);
	check("shared sentence stored once", conv.sentences.filter(s => s.text === "Hago la cena.").length, 1);
	check("bare-string sentence converted", conv.sentences.some(s => s.text === "Es un mapa."), true);
	check("unmatched pairs became manual rows", conv.links.map(l => l.wordId + ">" + l.sentenceId).sort(), ["b>s1", "c>s2"]);
	check("no word keeps examples", conv.words.some(w => "examples" in w), false);

	const v1File = path.join(root, "data", "vocab.v1.json");
	if (fs.existsSync(v1File)) {
		const report = js(`(() => {
			const old = JSON.parse(${JSON.stringify(fs.readFileSync(v1File, "utf8"))});
			const r = loadAny(old);
			db = r.db; relink();
			const lost = r.oldPairs.filter(p => !linkedWords(p.sentenceId).some(w => w.id === p.wordId));
			return { lost: lost.length, words: db.words.length, sentences: db.sentences.length };
		})()`);
		check("your kept v1 file still converts without losing a link", report.lost, 0);
	}

	section("saving from an out-of-date tab");
	// A copy of the server in the temp folder has its own data/, so the real file is never touched.
	const serverDir = path.join(tmpDir, "server");
	fs.mkdirSync(path.join(serverDir, "data"), { recursive: true });
	fs.cpSync(path.join(root, "lib"), path.join(serverDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(serverDir, "server.js"), fs.readFileSync(path.join(root, "server.js"), "utf8").replace("const PORT = 8787;", "const PORT = 8799;"));
	const server = spawn(process.execPath, ["server.js"], { cwd: serverDir, stdio: ["ignore", "pipe", "ignore"] });
	await new Promise(resolve => server.stdout.on("data", chunk => { if (String(chunk).includes("spanish-vocab on")) resolve(); }));

	const vocabUrl = "http://127.0.0.1:8799/api/vocab";
	const fileBody = words => JSON.stringify({ version: 2, words: words, sentences: [], links: [] });
	const put = async (time, words) => {
		const res = await fetch(vocabUrl, { method: "PUT", headers: time ? { "X-File-Time": time } : {}, body: fileBody(words) });
		await res.text();
		return { status: res.status, time: res.headers.get("X-File-Time") };
	};
	const get = async () => {
		const res = await fetch(vocabUrl);
		return { words: (await res.json()).words, time: res.headers.get("X-File-Time") };
	};

	const opened = (await get()).time;
	const first = await put(opened, ["first"]);
	check("a tab that matches the file can save", first.status, 200);
	const second = await put(first.time, ["second"]);
	check("the time from its last save keeps it current", second.status, 200);
	check("a tab behind the file is refused", (await put(opened, ["old tab"])).status, 409);
	check("a tab that sends no time is refused", (await put(null, ["older page"])).status, 409);
	check("refused saves leave the file alone", (await get()).words, ["second"]);
	const reloaded = await get();
	check("reloading catches the tab up", (await put(reloaded.time, ["third"])).status, 200);
	const beforeEdit = (await get()).time;
	fs.writeFileSync(path.join(serverDir, "data", "vocab.json"), fileBody(["by hand"]));
	check("a hand edit of the file counts as newer", (await put(beforeEdit, ["old tab"])).status, 409);
	check("the hand edit survives", (await get()).words, ["by hand"]);

	await new Promise(resolve => {
		server.once("exit", resolve);
		server.kill();
	});

	dictionary.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	console.log("\n" + (failures ? failures + " failed, " + passes + " passed" : "all " + passes + " passed"));
	process.exitCode = failures ? 1 : 0;
})().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
