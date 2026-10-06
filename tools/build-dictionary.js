// Builds data/dictionary.sqlite from a wiktextract dump of English Wiktionary.
//
//   node tools/build-dictionary.js dictionary-source/raw-wiktextract-data.jsonl.gz
//
// Accepts .jsonl or .jsonl.gz, the full dump or a Spanish-only file. Only entries whose own
// language is Spanish are kept. Writes to a temp file and swaps it in at the end, so a running
// server never opens a half-built dictionary.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const { lower, fold } = require("../lib/dictionary");

// Which cells of Wiktionary's conjugation table fill which of our tables. Checked in order;
// every tag listed must be present.
const TENSES = [
	["conditional", ["conditional"]],
	["present", ["indicative", "present"]],
	["preterite", ["indicative", "preterite"]],
	["imperfect", ["indicative", "imperfect"]],
	["future", ["indicative", "future"]],
	["subjunctive", ["subjunctive", "present"]],
	["imperfectSubjunctive", ["subjunctive", "imperfect"]],
	["imperative", ["imperative"]]
];

// Table cells that don't belong in a yo/tú/él/nosotros/vosotros/ellos grid: vos and usted
// variants, negative imperatives, the -se imperfect subjunctive and the archaic future
// subjunctive. They still go into the forms table, so they're found when typed.
const LEFT_OUT_OF_TABLES = ["vos-form", "formal", "second-person-semantically", "negative", "imperfect-se"];

const PSEUDO_FORMS = ["table-tags", "inflection-template", "class", "romanization"];
// Tags a noun's or adjective's own forms may carry; anything else (diminutive, obsolete…) is a
// different word, not an inflection.
const INFLECTION_TAGS = new Set(["plural", "singular", "feminine", "masculine"]);

function slot(tags) {
	const person = tags.includes("first-person") ? 0 : tags.includes("second-person") ? 1 : tags.includes("third-person") ? 2 : -1;
	if (person < 0) return -1;
	if (tags.includes("plural")) return person + 3;
	if (tags.includes("singular")) return person;
	return -1;
}

function conjugation(forms) {
	const conj = {};
	let filled = 0;
	for (const f of forms) {
		if (f.source !== "conjugation") continue;
		const tags = f.tags || [];
		if (tags.some(tag => PSEUDO_FORMS.includes(tag))) continue;
		if (tags.includes("gerund")) {
			conj.gerund = conj.gerund || f.form;
			continue;
		}
		if (tags.includes("participle") && tags.includes("past")) {
			if (!tags.includes("feminine") && !tags.includes("plural")) conj.participle = conj.participle || f.form;
			continue;
		}
		if (tags.some(tag => LEFT_OUT_OF_TABLES.includes(tag)) || tags.includes("future") && tags.includes("subjunctive")) continue;
		const index = slot(tags);
		if (index < 0) continue;
		const tense = TENSES.find(([, need]) => need.every(tag => tags.includes(tag)));
		if (!tense) continue;
		const table = conj[tense[0]] = conj[tense[0]] || { source: "dictionary", forms: ["", "", "", "", "", ""] };
		if (!table.forms[index]) {
			table.forms[index] = f.form;
			filled++;
		}
	}
	return filled ? conj : null;
}

function gender(entry) {
	for (const template of entry.head_templates || []) {
		if (template.name !== "es-noun") continue;
		const g = String((template.args || {})["1"] || "");
		if (g.startsWith("mf")) return "mf";
		if (g.startsWith("m")) return "m";
		if (g.startsWith("f")) return "f";
	}
	const tags = (entry.senses || []).flatMap(sense => sense.tags || []);
	const m = tags.includes("masculine");
	const f = tags.includes("feminine");
	return m && f ? "mf" : m ? "m" : f ? "f" : null;
}

function isFormSense(sense) {
	return Boolean((sense.form_of && sense.form_of.length) || (sense.alt_of && sense.alt_of.length));
}

// One dump line → the rows it contributes. Pure, so tests can call it on fixture lines.
function extract(entry) {
	const out = { entry: null, forms: [] };
	if (!entry || entry.lang_code !== "es" || !entry.word) return out;
	const word = entry.word;
	const senses = entry.senses || [];

	for (const sense of senses) {
		if (!isFormSense(sense)) continue;
		for (const target of (sense.form_of || []).concat(sense.alt_of || [])) {
			if (target && target.word && lower(target.word) !== lower(word)) {
				out.forms.push({ form: word, lemma: target.word, pos: entry.pos, tags: (sense.tags || []).filter(t => t !== "form-of").join(" ") });
			}
		}
	}

	const meanings = [];
	for (const sense of senses) {
		if (isFormSense(sense) || !sense.glosses || !sense.glosses.length) continue;
		// Sub-senses repeat their parent gloss first; the last gloss is the specific one.
		const gloss = sense.glosses[sense.glosses.length - 1];
		if (gloss && !meanings.includes(gloss)) meanings.push(gloss);
	}
	if (!meanings.length) return out;

	const forms = entry.forms || [];
	for (const f of forms) {
		const tags = f.tags || [];
		if (!f.form || tags.some(tag => PSEUDO_FORMS.includes(tag)) || lower(f.form) === lower(word)) continue;
		out.forms.push({ form: f.form, lemma: word, pos: entry.pos, tags: tags.join(" ") });
	}

	const inflections = entry.pos === "verb" ? [] : forms
		.filter(f => f.form && f.source !== "conjugation" && (f.tags || []).length && f.tags.every(tag => INFLECTION_TAGS.has(tag)))
		.map(f => f.form)
		.filter((form, i, all) => all.indexOf(form) === i && lower(form) !== lower(word));

	out.entry = {
		word: word,
		pos: entry.pos,
		gender: entry.pos === "noun" ? gender(entry) : null,
		senses: meanings.slice(0, 8),
		forms: inflections,
		conj: entry.pos === "verb" ? conjugation(forms) : null
	};
	return out;
}

async function build(input, output, log) {
	const tmp = output + ".tmp";
	if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
	const db = new DatabaseSync(tmp);
	db.exec(`
		PRAGMA journal_mode = OFF;
		PRAGMA synchronous = OFF;
		CREATE TABLE entries (id INTEGER PRIMARY KEY, word TEXT NOT NULL, lower TEXT NOT NULL, fold TEXT NOT NULL,
			pos TEXT NOT NULL, gender TEXT, senses TEXT NOT NULL, forms TEXT NOT NULL, conj TEXT);
		CREATE TABLE forms (form TEXT NOT NULL, lower TEXT NOT NULL, fold TEXT NOT NULL, lemma TEXT NOT NULL,
			pos TEXT NOT NULL, tags TEXT NOT NULL, UNIQUE (lower, lemma, pos));
		CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
	`);
	const addEntry = db.prepare("INSERT INTO entries (word, lower, fold, pos, gender, senses, forms, conj) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const addForm = db.prepare("INSERT OR IGNORE INTO forms (form, lower, fold, lemma, pos, tags) VALUES (?, ?, ?, ?, ?, ?)");

	let stream = fs.createReadStream(input);
	if (input.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

	let read = 0;
	let spanish = 0;
	let entries = 0;
	let batch = 0;
	const started = Date.now();
	db.exec("BEGIN");
	for await (const line of lines) {
		read++;
		if (read % 1000000 === 0) log("  " + (read / 1e6) + "M lines read, " + spanish + " Spanish, " + Math.round((Date.now() - started) / 1000) + "s");
		// Cheap pre-check. It also matches English entries that list Spanish translations, so
		// the entry's own lang_code is checked again after parsing.
		if (!line.includes('"lang_code": "es"') && !line.includes('"lang_code":"es"')) continue;
		let parsed;
		try { parsed = JSON.parse(line); } catch (_) { continue; }
		if (parsed.lang_code !== "es") continue;
		spanish++;

		const rows = extract(parsed);
		if (rows.entry) {
			const e = rows.entry;
			addEntry.run(e.word, lower(e.word), fold(e.word), e.pos, e.gender, JSON.stringify(e.senses), JSON.stringify(e.forms), e.conj ? JSON.stringify(e.conj) : null);
			entries++;
		}
		for (const f of rows.forms) addForm.run(f.form, lower(f.form), fold(f.form), f.lemma, f.pos, f.tags);
		if (++batch >= 20000) {
			db.exec("COMMIT; BEGIN");
			batch = 0;
		}
	}
	db.exec("COMMIT");

	log("  indexing…");
	db.exec(`
		CREATE INDEX entries_lower ON entries (lower);
		CREATE INDEX entries_fold ON entries (fold);
		CREATE INDEX entries_word ON entries (word, pos);
		CREATE INDEX forms_fold ON forms (fold);
	`);
	const formCount = db.prepare("SELECT count(*) AS n FROM forms").get().n;
	const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
	setMeta.run("source", path.basename(input));
	setMeta.run("built", new Date().toISOString());
	setMeta.run("entries", String(entries));
	setMeta.run("forms", String(formCount));
	db.exec("VACUUM");
	db.close();

	try {
		if (fs.existsSync(output)) fs.unlinkSync(output);
		fs.renameSync(tmp, output);
	} catch (err) {
		// Windows won't replace a file the running server has open.
		throw new Error("could not replace " + output + " (" + err.code + "). Stop the server, then rename "
			+ path.basename(tmp) + " to " + path.basename(output) + " — the new dictionary is complete.");
	}
	return { read: read, spanish: spanish, entries: entries, forms: formCount, bytes: fs.statSync(output).size, seconds: Math.round((Date.now() - started) / 1000) };
}

module.exports = { extract, build, conjugation };

if (require.main === module) {
	const input = process.argv[2];
	if (!input || !fs.existsSync(input)) {
		console.error("usage: node tools/build-dictionary.js <wiktextract .jsonl or .jsonl.gz>");
		process.exit(1);
	}
	const output = path.join(__dirname, "..", "data", "dictionary.sqlite");
	console.log("building " + output + " from " + input);
	build(input, output, console.log).then(result => {
		console.log("done in " + result.seconds + "s: " + result.read + " lines, " + result.spanish + " Spanish entries, "
			+ result.entries + " headwords, " + result.forms + " forms, " + (result.bytes / 1e6).toFixed(1) + " MB");
	}).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
