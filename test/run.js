// Run with:  node test/run.js
// Builds a small dictionary from test/fixtures/dict-sample.jsonl (real Wiktionary entries), then
// checks the dictionary lookups, the page's data model and linking, and the v1 conversion.
// Never writes to data/ — the real vocabulary file is only read.

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
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

	dictionary.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	console.log("\n" + (failures ? failures + " failed, " + passes + " passed" : "all " + passes + " passed"));
	process.exitCode = failures ? 1 : 0;
})().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
