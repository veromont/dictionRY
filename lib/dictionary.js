// Read side of the Wiktionary dictionary: opens data/dictionary.sqlite and answers "what is this
// word?". Used by server.js; the build lives in tools/build-dictionary.js.

const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ARTICLE_GENDER = { el: "m", los: "m", un: "m", unos: "m", la: "f", las: "f", una: "f", unas: "f" };
const INDEFINITE = new Set(["un", "una", "unos", "unas"]);

const POS_NAMES = {
	verb: "verb", noun: "noun", adj: "adjective", adv: "adverb", pron: "pronoun", prep: "preposition",
	conj: "conjunction", intj: "interjection", det: "determiner", article: "determiner", num: "number",
	phrase: "phrase", prep_phrase: "phrase", proverb: "phrase"
};

function lower(s) {
	return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Accents and ñ folded away — only for "did you mean": cómoda → comoda, año → ano.
function fold(s) {
	return lower(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Forms a learner rarely types on purpose. "cosa" is also a subjunctive of coser and "pies" a
// voseo form of piar; offering those every time would bury the real answer. They're only offered
// when nothing more common matches, so a deliberately typed "quiera" still resolves.
function isRareForm(tags) {
	const list = String(tags || "").split(" ");
	return ["subjunctive", "imperative", "vos-form", "voseo", "with-voseo"].some(tag => list.includes(tag));
}

// Everyday reading first when one spelling is several parts of speech. Grammar words win outright
// ("nada" is a pronoun before it is nothingness, "sobre" a preposition before an envelope); among
// the rest, the part of speech with more meanings ("placer" the noun, "hacer" the verb).
const GRAMMAR_WORDS = ["pron", "det", "prep", "conj"];

function readingOrder(a, b) {
	return (GRAMMAR_WORDS.includes(b.dictPos) - GRAMMAR_WORDS.includes(a.dictPos)) || b.senses.length - a.senses.length;
}

// One spelling is one word to a learner: "claro" as adjective, adverb and interjection becomes a
// single candidate with the everyday part of speech and the others' meanings labelled after it.
function combinePartsOfSpeech(candidates) {
	const groups = new Map();
	const out = [];
	for (const c of candidates) {
		if (c.via === "form") {
			out.push(c);
			continue;
		}
		const key = c.via + "|" + c.headword;
		if (!groups.has(key)) {
			groups.set(key, []);
			out.push(key);
		}
		groups.get(key).push(c);
	}
	return out.map(item => {
		if (typeof item !== "string") return item;
		const parts = groups.get(item).sort(readingOrder);
		const main = parts[0];
		for (const other of parts.slice(1)) {
			for (const sense of other.senses) main.senses.push("(" + other.pos + ") " + sense);
			for (const form of other.forms) if (!main.forms.includes(form)) main.forms.push(form);
			main.conj = main.conj || other.conj;
		}
		return main;
	});
}

function posName(pos) {
	return POS_NAMES[pos] || "other";
}

// Typing slips between two spellings: a letter added, dropped, changed, or two neighbours swapped
// (palcer → placer is one slip, not two).
function distance(a, b) {
	if (Math.abs(a.length - b.length) > 2) return 99;
	let before = null;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1);
		}
		before = prev;
		prev = row;
	}
	return prev[b.length];
}

// The article to show with a noun: the gender's own article, in the kind (el/un) the user typed.
function articleFor(gender, typed) {
	const indefinite = INDEFINITE.has(typed);
	if (gender === "m") return indefinite ? "un" : "el";
	if (gender === "f") return indefinite ? "una" : "la";
	return typed;
}

function openDictionary(file) {
	if (!fs.existsSync(file)) return null;
	const db = new DatabaseSync(file, { readOnly: true });

	const entriesByLower = db.prepare("SELECT * FROM entries WHERE lower = ?");
	const entriesByFold = db.prepare("SELECT * FROM entries WHERE fold = ?");
	const formsByLower = db.prepare("SELECT * FROM forms WHERE lower = ?");
	const formsByFold = db.prepare("SELECT * FROM forms WHERE fold = ?");
	const entriesOf = db.prepare("SELECT * FROM entries WHERE word = ? AND pos = ?");
	const entriesOfWord = db.prepare("SELECT * FROM entries WHERE word = ?");
	const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map(row => [row.key, row.value]));

	// Every headword's folded spelling, kept in memory so a typo can be matched against all of them.
	const headwords = db.prepare("SELECT fold, word, pos, length(senses) AS weight FROM entries").all();
	// How much Wiktionary has to say about a spelling, across all its parts of speech. There is no
	// word frequency in the data; this is the stand-in: common words have long entries.
	const foldWeight = new Map();
	for (const headword of headwords) foldWeight.set(headword.fold, (foldWeight.get(headword.fold) || 0) + headword.weight);

	// Several rows of one word and part of speech (different etymologies: sueño "sleep" and
	// sueño "dream") become one candidate with all their meanings.
	function merge(rows) {
		const groups = new Map();
		for (const row of rows) {
			const key = row.word + "|" + row.pos;
			let group = groups.get(key);
			if (!group) {
				group = { headword: row.word, pos: posName(row.pos), dictPos: row.pos, gender: null, senses: [], forms: [], conj: null };
				groups.set(key, group);
			}
			group.gender = group.gender || row.gender || null;
			for (const sense of JSON.parse(row.senses || "[]")) if (!group.senses.includes(sense)) group.senses.push(sense);
			for (const form of JSON.parse(row.forms || "[]")) if (!group.forms.includes(form)) group.forms.push(form);
			group.conj = group.conj || (row.conj ? JSON.parse(row.conj) : null);
		}
		return [...groups.values()];
	}

	function viaForms(formRows, via) {
		const out = [];
		for (const formRow of formRows) {
			for (const candidate of merge(entriesOf.all(formRow.lemma, formRow.pos))) {
				out.push(Object.assign(candidate, { via: via, form: formRow.form, formTags: formRow.tags }));
			}
		}
		return out;
	}

	function similar(key) {
		const limit = key.length <= 4 ? 1 : 2;
		const scored = [];
		for (const headword of headwords) {
			const d = distance(key, headword.fold);
			if (d <= limit) scored.push({ headword: headword, d: d });
		}
		// Equal slips: the commoner word first (recuerdar → recordar, not reguardar).
		scored.sort((a, b) => a.d - b.d || foldWeight.get(b.headword.fold) - foldWeight.get(a.headword.fold));
		const seen = new Set();
		const rows = [];
		for (const item of scored) {
			if (seen.has(item.headword.word)) continue;
			seen.add(item.headword.word);
			rows.push(...entriesOfWord.all(item.headword.word));
			if (seen.size >= 4) break;
		}
		return merge(rows).map(candidate => Object.assign(candidate, { via: "similar" }));
	}

	function lookup(query) {
		const typed = lower(query);
		const match = /^(el|la|los|las|un|una|unos|unas) (.+)$/.exec(typed);
		const article = match ? match[1] : null;
		const text = match ? match[2] : typed;
		if (!text) return { query: query, candidates: [] };

		let candidates = merge(entriesByLower.all(text)).map(c => Object.assign(c, { via: "headword" }))
			.concat(viaForms(formsByLower.all(text), "form"));
		if (candidates.length && text === fold(text)) {
			// Typed with no accents or ñ at all: the accented spelling is a different word, and
			// leaving accents out is the commonest slip — "jamas" is far more likely jamás than a
			// plural of jama. Typed with accents, they were meant.
			candidates = candidates.concat(merge(entriesByFold.all(fold(text)).filter(row => row.lower !== text))
				.map(c => Object.assign(c, { via: "spelling" })));
		} else if (!candidates.length) {
			candidates = merge(entriesByFold.all(fold(text))).map(c => Object.assign(c, { via: "spelling" }))
				.concat(viaForms(formsByFold.all(fold(text)), "spelling"));
		}
		if (!candidates.length && !text.includes(" ")) candidates = similar(fold(text));

		for (const c of candidates) c.rare = c.via !== "headword" && c.via !== "similar" && isRareForm(c.formTags);
		if (candidates.some(c => !c.rare)) candidates = candidates.filter(c => !c.rare);

		// Names and places ("Como", the city; "Claro", a surname) only when nothing else fits.
		const proper = c => c.dictPos === "name" || c.headword !== c.headword.toLowerCase();
		if (candidates.some(c => !proper(c))) candidates = candidates.filter(c => !proper(c));

		// When the spelling is a headword itself, only a conjugated verb is a real second reading
		// (sueño → soñar, trabajo → trabajar). A participle (peinado → peinar), a noun or adjective
		// inflection (izquierda → izquierdo) or a phrase containing it (nada → de nada) is not
		// what someone typing that word means.
		if (candidates.some(c => c.via === "headword")) {
			candidates = candidates.filter(c => c.via !== "form"
				|| (c.dictPos === "verb" && !c.headword.includes(" ") && !String(c.formTags).split(" ").includes("participle")));
		}

		// Headwords before forms; within each, the entry with more meanings is the likelier one.
		const order = { headword: 0, form: 1, spelling: 2, similar: 3 };
		candidates.sort((a, b) => order[a.via] - order[b.via] || (a.via === "similar" ? 0 : b.senses.length - a.senses.length));

		// An article means the user is naming a noun.
		if (article) {
			const nouns = candidates.filter(c => c.dictPos === "noun");
			if (nouns.length) candidates = nouns;
		}

		const seen = new Set();
		candidates = candidates.filter(c => {
			const key = c.headword + "|" + c.dictPos;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		candidates = combinePartsOfSpeech(candidates);

		for (const c of candidates) {
			c.display = c.headword;
			if (article && c.dictPos === "noun") {
				const expected = ARTICLE_GENDER[article];
				if (c.gender && c.gender !== "mf" && c.gender !== expected) {
					c.genderNote = c.headword + " is " + (c.gender === "f" ? "feminine" : "masculine");
				}
				c.display = articleFor(c.gender, article) + " " + c.headword;
			}
		}
		return { query: query, candidates: candidates.slice(0, 6) };
	}

	return { lookup: lookup, meta: meta, close: () => db.close() };
}

module.exports = { openDictionary, fold, lower, posName };
