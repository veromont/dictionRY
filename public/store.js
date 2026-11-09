// The data model: four tables — words, sentences, links, groups — plus the computed link view.
// Knows nothing about the screen. Needs text.js loaded first.
//
// links = (matched from the text + manual rows) − blocked rows
// Only the user's decisions are stored in `links`; automatic matches are rebuilt from the text
// after every change, so they can never go stale.

function emptyDb() {
	return { version: 2, words: [], sentences: [], links: [], activeDays: [], groups: [] };
}

let db = emptyDb();

// The current link view. Rebuilt by relink(); read through the helpers below.
let linkState = { index: null, auto: new Map(), bySentence: new Map(), byWord: new Map() };

// --- words -----------------------------------------------------------------

// Verb tables, in the order the panel shows them. Filled from the dictionary.
const TENSES = ["present", "preterite", "imperfect", "future", "conditional", "subjunctive", "imperfectSubjunctive", "imperative"];
const TENSE_LABELS = {
	present: "present", preterite: "preterite", imperfect: "imperfect", future: "future", conditional: "conditional",
	subjunctive: "present subjunctive", imperfectSubjunctive: "imperfect subjunctive", imperative: "imperative"
};
const PRONOUNS = ["yo", "tú", "él/ella", "nosotros", "vosotros", "ellos"];
const POS_OPTIONS = ["verb", "noun", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection", "determiner", "phrase", "other"];

function conjForms(word) {
	if (!word.conj) return [];
	const forms = TENSES.flatMap(tense => (word.conj[tense] && word.conj[tense].forms) || []);
	if (word.conj.gerund) forms.push(word.conj.gerund);
	if (word.conj.participle) forms.push(word.conj.participle);
	return forms.filter(Boolean);
}

// Keeps a word's part of speech and verb table consistent after an edit: a word that is no
// longer a verb loses its table.
function normalizeWord(word) {
	if (!word.pos) word.pos = "other";
	if (word.pos !== "verb") delete word.conj;
}

// Copies a dictionary candidate (from /api/dict) onto a word. Your own gloss, notes and any table
// you corrected ("yours") are never touched.
function applyDictionary(word, candidate) {
	word.dict = { headword: candidate.headword, pos: candidate.dictPos, senses: candidate.senses.slice(0, 6) };
	word.pos = candidate.pos;
	if (candidate.gender) word.gender = candidate.gender; else delete word.gender;
	if (candidate.forms && candidate.forms.length) word.forms = candidate.forms.slice(); else delete word.forms;

	if (candidate.pos === "verb" && candidate.conj) {
		const old = word.conj || {};
		const conj = {};
		for (const tense of TENSES) {
			if (old[tense] && old[tense].source === "yours") conj[tense] = old[tense];
			else if (candidate.conj[tense]) conj[tense] = candidate.conj[tense];
		}
		const presentIsYours = old.present && old.present.source === "yours";
		conj.gerund = presentIsYours && old.gerund ? old.gerund : candidate.conj.gerund || "";
		conj.participle = presentIsYours && old.participle ? old.participle : candidate.conj.participle || "";
		word.conj = conj;
	} else if (candidate.pos !== "verb") {
		delete word.conj;
	}
	word.updatedAt = Date.now();
}

function meaningOf(word) {
	if ((word.gloss || "").trim()) return { text: word.gloss, from: "yours" };
	if (word.dict && word.dict.senses && word.dict.senses.length) return { text: word.dict.senses.slice(0, 3).join("; "), from: "dictionary" };
	if (word.auto && word.autoState === "ok") return { text: word.auto, from: "machine" };
	return { text: "", from: word.autoState === "pending" ? "pending" : "none" };
}

// Folds `word` into `target`: one entry per headword. Pinned and blocked links move across,
// automatic ones follow by themselves; a second meaning is kept as a note.
function mergeWordInto(word, target) {
	const carried = [target.notes, word.notes];
	if (!(target.gloss || "").trim()) target.gloss = word.gloss || "";
	else if ((word.gloss || "").trim() && word.gloss.trim() !== target.gloss.trim()) carried.push(word.es + ": " + word.gloss);
	target.notes = carried.map(note => (note || "").trim()).filter(Boolean).join(" · ");
	for (const row of db.links) if (row.wordId === word.id) row.wordId = target.id;
	addGroupIds(target, word.groupIds);
	db.words = db.words.filter(other => other !== word);
	target.updatedAt = Date.now();
}

function findWordByKey(key) {
	return db.words.find(word => word.key === key) || null;
}

// Accepts what a person would type: "hermosa", "la meta", or any stored form like "haremos".
function resolveWord(raw) {
	const key = normKey(raw);
	if (!key) return null;
	const direct = db.words.find(word => word.key === key);
	if (direct) return direct;
	const ids = linkState.index ? tokenWordIds(linkState.index, raw.trim()) : new Set();
	return db.words.find(word => ids.has(word.id)) || null;
}

function removeWord(id) {
	db.words = db.words.filter(word => word.id !== id);
	db.links = db.links.filter(row => row.wordId !== id);
}

// --- sentences ---------------------------------------------------------------

// Identity for "is this the same sentence": case, accents, spacing and a trailing full stop
// don't make a different sentence.
function sentenceKey(text) {
	return String(text || "")
		.toLowerCase()
		.normalize("NFD").replace(/[̀-ͯ]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?…]+$/, "")
		.trim();
}

function findSentenceByText(text, exceptId) {
	const key = sentenceKey(text);
	return db.sentences.find(sentence => sentence.id !== exceptId && sentenceKey(sentence.text) === key) || null;
}

function createSentence(text, source) {
	markActiveDay();
	const now = Date.now();
	const sentence = { id: crypto.randomUUID(), text: text.trim(), source: (source || "").trim(), createdAt: now, updatedAt: now };
	db.sentences.unshift(sentence);
	return sentence;
}

function editSentence(sentence, text, source) {
	sentence.text = text.trim();
	sentence.source = (source || "").trim();
	sentence.updatedAt = Date.now();
}

function removeSentence(id) {
	db.sentences = db.sentences.filter(sentence => sentence.id !== id);
	db.links = db.links.filter(row => row.sentenceId !== id);
}

// --- links -------------------------------------------------------------------

function addTo(map, key, id) {
	if (!key) return;
	let set = map.get(key);
	if (!set) map.set(key, set = new Set());
	set.add(id);
}

// Every spelling that should find a word: the word itself, its plurals, and each stored
// conjugated form. Built once per change, then every sentence is just a series of lookups.
function buildIndex(words) {
	const byKey = new Map();
	const byForm = new Map();
	const phrases = [];
	for (const word of words) {
		const key = word.key;
		if (!key) continue;
		if (key.includes(" ")) {
			phrases.push({ key: key, id: word.id });
			continue;
		}
		addTo(byKey, key, word.id);
		// Words from the dictionary carry their real plurals and feminines in `forms`. Only the
		// rest fall back to guessing plurals both ways — mapa/mapas, ciudad/ciudades — for
		// words of 3+ letters, so short words like "a" and "as" never swallow each other.
		if (!word.dict && key.length >= 3) {
			addTo(byKey, key + "s", word.id);
			addTo(byKey, key + "es", word.id);
			if (key.endsWith("es") && key.length >= 5) addTo(byKey, key.slice(0, -2), word.id);
			if (key.endsWith("s") && key.length >= 4) addTo(byKey, key.slice(0, -1), word.id);
		}
		// Forms keep ñ (verbKey): sueño is soñar, never sonar.
		for (const form of conjForms(word).concat(word.forms || [])) addTo(byForm, verbKey(form), word.id);
	}
	return { byKey: byKey, byForm: byForm, phrases: phrases };
}

function tokenWordIds(index, token) {
	const ids = new Set(index.byKey.get(normKey(token)) || []);
	for (const id of index.byForm.get(verbKey(token)) || []) ids.add(id);
	return ids;
}

function matchedWordIds(index, text) {
	const ids = new Set();
	for (const token of String(text || "").match(WORDS_IN_TEXT) || []) {
		for (const id of tokenWordIds(index, token)) ids.add(id);
	}
	if (index.phrases.length) {
		const whole = normKey(text);
		for (const phrase of index.phrases) if (whole.includes(phrase.key)) ids.add(phrase.id);
	}
	return ids;
}

// Rebuilds the link view from scratch. Called after every change; also drops link rows that
// point at a word or sentence that no longer exists.
function relink() {
	cleanGroups();
	const index = buildIndex(db.words);
	const wordIds = new Set(db.words.map(word => word.id));
	const sentenceIds = new Set(db.sentences.map(sentence => sentence.id));

	const seen = new Set();
	db.links = db.links.filter(row => {
		const pair = row.wordId + "|" + row.sentenceId + "|" + row.kind;
		if (seen.has(pair) || !wordIds.has(row.wordId) || !sentenceIds.has(row.sentenceId)) return false;
		seen.add(pair);
		return row.kind === "manual" || row.kind === "blocked";
	});

	const auto = new Map();
	const bySentence = new Map();
	for (const sentence of db.sentences) {
		const matched = matchedWordIds(index, sentence.text);
		auto.set(sentence.id, matched);
		bySentence.set(sentence.id, new Set(matched));
	}
	for (const row of db.links) if (row.kind === "manual") bySentence.get(row.sentenceId).add(row.wordId);
	for (const row of db.links) if (row.kind === "blocked") bySentence.get(row.sentenceId).delete(row.wordId);

	const byWord = new Map();
	for (const [sentenceId, set] of bySentence) {
		for (const wordId of set) addTo(byWord, wordId, sentenceId);
	}
	linkState = { index: index, auto: auto, bySentence: bySentence, byWord: byWord };
}

function isAutoLink(sentenceId, wordId) {
	const matched = linkState.auto.get(sentenceId);
	return Boolean(matched && matched.has(wordId));
}

function isManualLink(sentenceId, wordId) {
	return db.links.some(row => row.kind === "manual" && row.sentenceId === sentenceId && row.wordId === wordId);
}

function linkedWords(sentenceId) {
	const set = linkState.bySentence.get(sentenceId);
	return set ? db.words.filter(word => set.has(word.id)) : [];
}

function linkedSentences(wordId) {
	const set = linkState.byWord.get(wordId);
	if (!set) return [];
	return db.sentences.filter(sentence => set.has(sentence.id)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function pinLink(sentenceId, wordId) {
	db.links = db.links.filter(row => !(row.kind === "blocked" && row.sentenceId === sentenceId && row.wordId === wordId));
	if (!isAutoLink(sentenceId, wordId) && !isManualLink(sentenceId, wordId)) {
		db.links.push({ wordId: wordId, sentenceId: sentenceId, kind: "manual" });
	}
}

function unpinLink(sentenceId, wordId) {
	db.links = db.links.filter(row => !(row.kind === "manual" && row.sentenceId === sentenceId && row.wordId === wordId));
	const blocked = db.links.some(row => row.kind === "blocked" && row.sentenceId === sentenceId && row.wordId === wordId);
	if (isAutoLink(sentenceId, wordId) && !blocked) db.links.push({ wordId: wordId, sentenceId: sentenceId, kind: "blocked" });
}

// --- groups ------------------------------------------------------------------
//
// Words you mix up with each other. A word lists the groups it is in (`groupIds`); a group doesn't
// list its words, so the two sides can't disagree.

function addGroupIds(word, ids) {
	if (ids && ids.length) word.groupIds = [...new Set((word.groupIds || []).concat(ids))];
}

function groupWords(group) {
	return db.words.filter(word => (word.groupIds || []).includes(group.id)).sort((a, b) => a.es.localeCompare(b.es, "es"));
}

function groupsOf(word) {
	const ids = word.groupIds || [];
	return db.groups.filter(group => ids.includes(group.id));
}

function findGroupWith(words) {
	return db.groups.find(group => {
		const members = groupWords(group);
		return members.length === words.length && words.every(word => members.includes(word));
	}) || null;
}

// Adding a word to a group means you're learning it. A learned word keeps the progress it earned.
function addToGroup(group, word) {
	addGroupIds(word, [group.id]);
	if (word.state === "new") startLearning(word);
	group.updatedAt = Date.now();
}

function createGroup(words, note) {
	const now = Date.now();
	const group = { id: crypto.randomUUID(), note: (note || "").trim(), createdAt: now, updatedAt: now };
	db.groups.unshift(group);
	for (const word of words) addToGroup(group, word);
	return group;
}

function removeFromGroup(group, word) {
	word.groupIds = (word.groupIds || []).filter(id => id !== group.id);
	group.updatedAt = Date.now();
}

function removeGroup(id) {
	db.groups = db.groups.filter(group => group.id !== id);
}

// Runs with every relink, so deleting a word, merging and leaving a group need no cleanup of their
// own: a group left with fewer than two words goes, and its id comes off the words.
function cleanGroups() {
	const counts = new Map();
	for (const word of db.words) {
		for (const id of word.groupIds || []) counts.set(id, (counts.get(id) || 0) + 1);
	}
	db.groups = db.groups.filter(group => counts.get(group.id) >= 2);
	const kept = new Set(db.groups.map(group => group.id));
	for (const word of db.words) {
		if (!word.groupIds) continue;
		word.groupIds = word.groupIds.filter(id => kept.has(id));
		if (!word.groupIds.length) delete word.groupIds;
	}
}

// --- learning ----------------------------------------------------------------
//
// A word is new, learning or learned. "Archived" is not stored: it is a new word nobody has
// opened for ARCHIVE_AFTER active days. All time is counted in active days — days you used the
// site — so time away from it moves nothing. Days before this feature existed are reconstructed
// from when words and sentences were added, the only record of them.

const ARCHIVE_AFTER = 7;
// Gap before the next flashcard review, in active days, after each correct answer in a row.
const LADDER = [1, 3, 7, 21, 60, 150];
// Correct answers on different active days that move a word from learning to learned.
const LEARNED_AFTER = 3;
const CARD_TYPES = ["meaning", "spanish", "cloze", "which"];

function dateKey(time) {
	return new Date(time).toLocaleDateString("sv");
}

// Today's position on the active-day clock. Until the day's first click it shares the last active
// day's number.
function today() {
	return db.activeDays.length;
}

function markActiveDay() {
	const key = dateKey(Date.now());
	if (!db.activeDays.includes(key)) db.activeDays = db.activeDays.concat(key).sort();
}

function dayOf(time) {
	const index = db.activeDays.indexOf(dateKey(time));
	return index < 0 ? today() : index + 1;
}

function wordState(word) {
	if (word.state === "new" && today() - (word.touched || 0) >= ARCHIVE_AFTER) return "archived";
	return word.state || "new";
}

function archivesIn(word) {
	return ARCHIVE_AFTER - (today() - (word.touched || 0));
}

// Opening a new word, or an archived one (which brings it back), restarts its clock.
function touchWord(word) {
	if (word.state !== "new" || word.touched === today()) return false;
	word.touched = today();
	return true;
}

function startLearning(word) {
	word.state = "learning";
	word.review = { step: 0, due: today(), streak: 0, lastCorrect: null, next: 0 };
	delete word.touched;
}

function moveWord(word, state) {
	if (state === "learning") return startLearning(word);
	if (state === "new") {
		word.state = "new";
		word.touched = today();
		delete word.review;
		return;
	}
	// Marked learned by hand: treated as if the streak had been earned, so the next review lands on
	// the rung a word reaches by earning it.
	const next = word.review ? word.review.next : 0;
	word.state = "learned";
	word.review = { step: LEARNED_AFTER + 1, due: today() + LADDER[LEARNED_AFTER], streak: LEARNED_AFTER, lastCorrect: today(), next: next };
}

// Words without a state yet: the first load after this feature, or an import. Words with a
// sentence start learning; the rest are new, their clock counted from the day they were added.
// Returns true if anything changed.
function initLearning() {
	let changed = false;
	for (const word of db.words) {
		if (word.state) continue;
		if (linkedSentences(word.id).length) startLearning(word);
		else {
			word.state = "new";
			word.touched = word.createdAt ? dayOf(word.createdAt) : today();
		}
		changed = true;
	}
	return changed;
}

// The first sentence a word gets starts its learning. Only the moment it gains one counts, so a
// word moved back to new by hand stays new. Returns the words that started.
function relinkAndStartLearning() {
	const firstRun = !linkState.index;
	const before = new Map([...linkState.byWord].map(([id, set]) => [id, set.size]));
	relink();
	if (firstRun) return [];
	const started = [];
	for (const word of db.words) {
		if (word.state !== "new" || before.get(word.id) || !linkedSentences(word.id).length) continue;
		startLearning(word);
		started.push(word);
	}
	return started;
}

function dueWords(state) {
	return db.words.filter(word => wordState(word) === state && word.review && word.review.due <= today());
}

// Back to the start of the ladder. Returns true if a learned word dropped to learning.
function resetReview(word) {
	const lapsed = word.state === "learned";
	word.review.step = 0;
	word.review.streak = 0;
	word.review.lastCorrect = null;
	word.review.due = today();
	if (lapsed) word.state = "learning";
	return lapsed;
}

// A miss on a "which" card means the words of that group can't be told apart yet, so `word`'s
// group mates lose their progress too. Words moved back to new have none to lose.
function resetGroup(group, word) {
	return groupWords(group)
		.filter(other => other !== word && other.review)
		.map(other => ({ word: other, lapsed: resetReview(other) }));
}

// Only the first correct answer of an active day moves a word up: more practice the same day
// changes nothing, and promotion needs LEARNED_AFTER separate days. A miss always counts.
// Returns "missed", "knew", "learned" or "lapsed" (a learned word dropping back to learning).
function grade(word, knew) {
	const review = word.review || (word.review = { step: 0, due: today(), streak: 0, lastCorrect: null, next: 0 });
	review.next = (review.next || 0) + 1;
	if (!knew) return resetReview(word) ? "lapsed" : "missed";
	if (review.lastCorrect === today()) return "knew";
	review.lastCorrect = today();
	review.streak++;
	review.due = today() + LADDER[Math.min(review.step, LADDER.length - 1)];
	review.step++;
	if (word.state === "learning" && review.streak >= LEARNED_AFTER) {
		word.state = "learned";
		return "learned";
	}
	return "knew";
}

// One of the word's own sentences with the word blanked out, chosen in rotation. Only sentences
// where the word (or one of its forms) actually appears qualify, so a hand-pinned link to a
// sentence that doesn't contain it never makes a gap with nothing to fill.
function clozeFor(word, turn) {
	const options = [];
	for (const sentence of linkedSentences(word.id)) {
		const re = new RegExp(WORDS_IN_TEXT.source, "gu");
		let match;
		while ((match = re.exec(sentence.text))) {
			if (!tokenWordIds(linkState.index, match[0]).has(word.id)) continue;
			options.push({
				before: sentence.text.slice(0, match.index),
				answer: match[0],
				after: sentence.text.slice(match.index + match[0].length),
				sentence: sentence
			});
			break;
		}
	}
	return options.length ? options[turn % options.length] : null;
}

function shuffled(list) {
	const out = list.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// The next flashcard for a word, cycling through the card types it can make.
function cardFor(word) {
	const turn = (word.review && word.review.next) || 0;
	const round = Math.floor(turn / CARD_TYPES.length);
	const meaning = meaningOf(word).text;
	const cloze = clozeFor(word, round);
	const groups = groupsOf(word);
	const group = groups.length ? groups[round % groups.length] : null;
	const types = CARD_TYPES.filter(type => type === "cloze" ? cloze : type === "which" ? meaning && group : meaning);
	if (!types.length) return null;
	const sentence = cloze ? cloze.sentence : linkedSentences(word.id)[0];
	return {
		word: word, type: types[turn % types.length], meaning: meaning, cloze: cloze, sentence: sentence || null,
		group: group, choices: group ? shuffled(groupWords(group)) : []
	};
}

// --- loading and saving ------------------------------------------------------------

// The v1 file was one array of words, each carrying copies of its sentences. Every old
// word↔sentence pair survives: the ones the matcher finds on its own need no row, the rest
// become `manual` rows. Now only used for importing an old export.
function fromV1(list) {
	const words = list.filter(word => word && String(word.es || "").trim()).map(word => Object.assign({}, word));
	for (const word of words) {
		if (!word.id) word.id = crypto.randomUUID();
		if (!word.key) word.key = normKey(word.es);
	}

	const sentences = [];
	const byOldId = new Map();
	const byText = new Map();
	const oldPairs = [];
	for (const word of words) {
		for (const ex of Array.isArray(word.examples) ? word.examples : []) {
			// A hand-edited file may hold a bare string: "examples": ["Vivo en la ciudad."]
			const text = String(typeof ex === "string" ? ex : (ex && ex.text) || "").trim();
			if (!text) continue;
			const oldId = typeof ex === "object" ? ex.id : null;
			let sentence = (oldId && byOldId.get(oldId)) || byText.get(sentenceKey(text));
			if (!sentence) {
				const at = (typeof ex === "object" && ex.addedAt) || word.createdAt || Date.now();
				sentence = {
					id: oldId || crypto.randomUUID(),
					text: text,
					source: String((typeof ex === "object" && ex.source) || ""),
					createdAt: at,
					updatedAt: at
				};
				sentences.push(sentence);
				byText.set(sentenceKey(text), sentence);
			}
			if (oldId) byOldId.set(oldId, sentence);
			oldPairs.push({ wordId: word.id, sentenceId: sentence.id });
		}
		delete word.examples;
	}

	for (const word of words) normalizeWord(word);

	const converted = { version: 2, words: words, sentences: sentences, links: [], groups: [] };
	const index = buildIndex(words);
	const byId = new Map(sentences.map(sentence => [sentence.id, sentence]));
	const seen = new Set();
	for (const pair of oldPairs) {
		const key = pair.wordId + "|" + pair.sentenceId;
		if (seen.has(key)) continue;
		seen.add(key);
		if (!matchedWordIds(index, byId.get(pair.sentenceId).text).has(pair.wordId)) {
			converted.links.push({ wordId: pair.wordId, sentenceId: pair.sentenceId, kind: "manual" });
		}
	}
	return { db: converted, renamed: [], merged: [], oldPairs: oldPairs };
}

// Files from before the learning feature have no list of active days: rebuild it from the days
// words and sentences were added.
function withActiveDays(data) {
	if (!Array.isArray(data.activeDays)) {
		const added = data.words.map(word => word.createdAt).concat(data.sentences.map(sentence => sentence.createdAt));
		data.activeDays = [...new Set(added.filter(Boolean).map(dateKey))].sort();
	}
	return data;
}

// Takes whatever the server or an import file holds and returns a v2 database.
function loadAny(parsed) {
	if (Array.isArray(parsed)) {
		const converted = fromV1(parsed);
		withActiveDays(converted.db);
		return Object.assign({ converted: true }, converted);
	}
	if (parsed && Array.isArray(parsed.words) && Array.isArray(parsed.sentences) && Array.isArray(parsed.links)) {
		return {
			converted: false,
			db: withActiveDays({ version: 2, words: parsed.words, sentences: parsed.sentences, links: parsed.links, activeDays: parsed.activeDays, groups: parsed.groups || [] }),
			renamed: [],
			merged: []
		};
	}
	throw new Error("not a vocab file");
}

function snapshot() {
	return JSON.stringify({ version: 2, words: db.words, sentences: db.sentences, links: db.links, activeDays: db.activeDays, groups: db.groups }, null, 2);
}

// Folds another database into the current one: same word (by spelling) or same sentence (by
// text) is kept once, and link rows are re-pointed at whichever copy survived.
function mergeDb(incoming) {
	const wordIds = new Map();
	const sentenceIds = new Map();
	let addedWords = 0;
	let addedSentences = 0;

	for (const group of incoming.groups) {
		if (!db.groups.some(other => other.id === group.id)) db.groups.push(Object.assign({}, group));
	}
	for (const word of incoming.words) {
		const existing = findWordByKey(word.key || normKey(word.es));
		if (existing) {
			wordIds.set(word.id, existing.id);
			addGroupIds(existing, word.groupIds);
			continue;
		}
		const copy = Object.assign({}, word);
		if (!copy.id || db.words.some(other => other.id === copy.id)) copy.id = crypto.randomUUID();
		copy.key = copy.key || normKey(copy.es);
		normalizeWord(copy);
		wordIds.set(word.id, copy.id);
		db.words.unshift(copy);
		addedWords++;
	}
	for (const sentence of incoming.sentences) {
		const existing = findSentenceByText(sentence.text);
		if (existing) {
			sentenceIds.set(sentence.id, existing.id);
			continue;
		}
		const copy = Object.assign({}, sentence);
		if (!copy.id || db.sentences.some(other => other.id === copy.id)) copy.id = crypto.randomUUID();
		sentenceIds.set(sentence.id, copy.id);
		db.sentences.unshift(copy);
		addedSentences++;
	}
	for (const row of incoming.links) {
		const wordId = wordIds.get(row.wordId);
		const sentenceId = sentenceIds.get(row.sentenceId);
		if (wordId && sentenceId) db.links.push({ wordId: wordId, sentenceId: sentenceId, kind: row.kind });
	}
	if (Array.isArray(incoming.activeDays)) {
		db.activeDays = [...new Set((db.activeDays || []).concat(incoming.activeDays))].sort();
	}
	return { addedWords: addedWords, skippedWords: incoming.words.length - addedWords, addedSentences: addedSentences };
}
