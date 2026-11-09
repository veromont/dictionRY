// State of the screen, what every button does, saving, and start-up. Drawing is in views.js.

const PENDING_KEY = "spanish-vocab-pending";
const PENDING_TIME_KEY = "spanish-vocab-pending-time";

let filter = "";
let view = "learning";
let editingId = null;
let openId = null;
let flashId = null;
let focusSentenceFor = null;
let conjEdit = null;
let sentenceEditId = null;
let linkingId = null;
let groupNoteId = null;
let groupAddId = null;
let confusedWithId = null;
let moreTenses = new Set();
let formsOpen = new Set();
// Sentence boxes under words: what was typed but not added yet, by word id.
const drafts = new Map();
// The flashcard session in progress, or null.
let study = null;
let reviewItems = [];
let dictAvailable = true;
let saveTimer = null;
let retryTimer = null;
// Set when the file never loaded. Saving then would overwrite the real file with an empty one.
let loadFailed = false;
let loaded = false;
let dayTurned = false;
// When the file last changed, as far as this tab knows. The server refuses a save if it's older.
let fileTime = null;
let saving = false;
let saveAgain = false;

const el = {};
for (const id of ["count", "studyNow", "tabs", "tools", "addForm", "addInput", "searchBox", "search", "sentenceForm",
	"sentenceInput", "sentenceSource", "groupForm", "groupInputs", "groupNote", "notice", "content", "wordList", "footer", "state"]) {
	el[id] = document.getElementById(id);
}

function setState(kind, text) {
	el.state.className = "save-state " + kind;
	el.state.textContent = text;
}

function notify(msg, actions) {
	el.notice.textContent = msg || "";
	if (msg && actions && actions.length) el.notice.append(h("div", null, actions.map(item => btn(item.label, item.onClick, "btn choice-btn"))));
	el.notice.classList.toggle("on", Boolean(msg));
}

function scheduleSave() {
	if (loadFailed) {
		setState("unsaved", "Not saved — the file never loaded, reload the page");
		return;
	}
	clearTimeout(saveTimer);
	setState("saving", "Saving…");
	saveTimer = setTimeout(save, 400);
}

function clearPending() {
	localStorage.removeItem(PENDING_KEY);
	localStorage.removeItem(PENDING_TIME_KEY);
}

// One save at a time: a second one sent before the first answers would carry the time the first
// just made old, and be refused.
async function save() {
	if (saving) {
		saveAgain = true;
		return;
	}
	saving = true;
	const body = snapshot();
	try {
		const res = await fetch("/api/vocab", {
			method: "PUT",
			headers: { "Content-Type": "application/json", "X-File-Time": fileTime },
			body: body
		});
		if (res.status === 409) {
			saveAgain = false;
			clearPending();
			clearTimeout(retryTimer);
			retryTimer = null;
			setState("unsaved", "Not saved — this tab is out of date");
			if (confirm("This tab is out of date: newer data was saved since it loaded, so your last change wasn't saved.\n\nReload from the saved data?")) location.reload();
			return;
		}
		if (!res.ok) throw new Error("HTTP " + res.status);
		fileTime = res.headers.get("X-File-Time");
		clearPending();
		clearTimeout(retryTimer);
		retryTimer = null;
		setState("saved", "Saved");
	} catch (err) {
		// Server down or machine slept: hold the data in the browser and keep trying.
		try {
			localStorage.setItem(PENDING_KEY, body);
			localStorage.setItem(PENDING_TIME_KEY, fileTime);
		} catch (_) {}
		setState("unsaved", "Unsaved — retrying");
		clearTimeout(retryTimer);
		retryTimer = setTimeout(save, 5000);
	} finally {
		saving = false;
		if (saveAgain) {
			saveAgain = false;
			save();
		}
	}
}

// Every change goes through here: links are recomputed from the new state (which can start a
// word's learning), then saved and drawn. Returns the words that started learning.
function changed() {
	const started = relinkAndStartLearning();
	initLearning();
	refreshWordList();
	scheduleSave();
	render();
	return started;
}

function refreshWordList() {
	el.wordList.textContent = "";
	for (const word of db.words) el.wordList.append(h("option", { value: word.es }));
}

// --- opening words ------------------------------------------------------------------

// Shows a word in the tab its state belongs to, opened. Opening counts as touching it, which also
// brings an archived word back to new.
function showWord(word, keepFilter) {
	if (touchWord(word)) scheduleSave();
	study = null;
	view = VIEW_OF_STATE[wordState(word)];
	if (!keepFilter) {
		filter = "";
		el.search.value = "";
	}
	openId = word.id;
	flashId = word.id;
	applyView();
	render();
}

function openWord(word) {
	filter = word.es;
	el.search.value = word.es;
	showWord(word, true);
}

function toggleOpen(word) {
	const opening = openId !== word.id;
	openId = opening ? word.id : null;
	notify("");
	if (opening && touchWord(word)) scheduleSave();
	render();
}

function toggleEdit(word) {
	editingId = editingId === word.id ? null : word.id;
	if (editingId) focusSentenceFor = "gloss-" + word.id;
	render();
}

function closeEdit() {
	editingId = null;
	render();
}

function toggleForms(word) {
	if (formsOpen.has(word.id)) formsOpen.delete(word.id); else formsOpen.add(word.id);
	render();
}

function toggleMoreTenses(word) {
	if (moreTenses.has(word.id)) moreTenses.delete(word.id); else moreTenses.add(word.id);
	render();
}

function moveTo(word, state) {
	moveWord(word, state);
	changed();
	notify('"' + word.es + '" moved to ' + state + ".", [{ label: "Show it", onClick: () => showWord(word) }]);
}

function restoreWord(word) {
	showWord(word);
	notify('"' + word.es + '" is back in new.');
}

function deleteWord(word) {
	const count = linkedSentences(word.id).length;
	const kept = count ? "\n\nIts " + count + (count === 1 ? " sentence stays." : " sentences stay.") : "";
	const lostGroups = groupsOf(word).filter(group => groupWords(group).length <= 2).length;
	const lost = lostGroups ? "\n\n" + plural(lostGroups, "group") + " with only two words will be deleted too." : "";
	if (!confirm('Delete "' + word.es + '"?' + kept + lost)) return;
	removeWord(word.id);
	if (editingId === word.id) editingId = null;
	if (openId === word.id) openId = null;
	changed();
}

function saveWordEdit(word, values) {
	const es = values.es.trim();
	let renamed = false;
	if (es) {
		const key = normKey(es);
		const clash = db.words.find(other => other.key === key && other.id !== word.id);
		if (clash) {
			notify('"' + clash.es + '" already uses that word — rename cancelled.');
		} else if (key !== word.key) {
			word.es = es;
			word.key = key;
			renamed = true;
		}
	}
	word.gloss = values.gloss.trim();
	word.notes = values.notes.trim();
	word.pos = values.pos;
	if (renamed) delete word.dictReview;
	touchWord(word);
	normalizeWord(word);
	word.updatedAt = Date.now();
	editingId = null;
	changed();
}

// --- sentences ------------------------------------------------------------------

function addSentenceFor(word, rawText, source) {
	const text = rawText.trim();
	if (!text) return;
	const existing = findSentenceByText(text);
	if (existing) {
		pinLink(existing.id, word.id);
		notify("You already had that sentence — linked it to " + word.es + ".");
	} else {
		const sentence = createSentence(text, source);
		// Stored by hand only when the text alone wouldn't link it, e.g. a preterite form.
		if (!matchedWordIds(linkState.index, sentence.text).has(word.id)) pinLink(sentence.id, word.id);
		const others = [...matchedWordIds(linkState.index, sentence.text)]
			.filter(id => id !== word.id)
			.map(id => db.words.find(other => other.id === id).es);
		notify(others.length ? "Also linked to " + others.join(", ") + "." : "");
	}
	drafts.delete(word.id);
	focusSentenceFor = "add-" + word.id;
	const started = changed();
	if (started.includes(word)) {
		// Its first sentence moved it out of the tab you were in; follow it.
		showWord(word);
		focusSentenceFor = "add-" + word.id;
		render();
		notify('"' + word.es + '" has its first sentence — it\'s now in learning.');
	} else if (started.length) {
		notify("Started learning: " + started.map(other => other.es).join(", ") + ".");
	}
}

function unlink(sentence, word) {
	unpinLink(sentence.id, word.id);
	changed();
}

function toggleLinking(sentence) {
	linkingId = linkingId === sentence.id ? null : sentence.id;
	if (linkingId) focusSentenceFor = "link-" + sentence.id;
	render();
}

function cancelLinking() {
	linkingId = null;
	render();
}

function linkTyped(sentence, rawValue) {
	const raw = rawValue.trim();
	if (!raw) return;
	const word = resolveWord(raw);
	if (!word) {
		notify('"' + raw + '" isn\'t saved yet — add it as a word first.');
		return;
	}
	pinLink(sentence.id, word.id);
	linkingId = null;
	notify("");
	changed();
}

function startSentenceEdit(sentence) {
	sentenceEditId = sentence.id;
	focusSentenceFor = "edit-" + sentence.id;
	render();
}

function cancelSentenceEdit() {
	sentenceEditId = null;
	render();
}

function saveSentenceEdit(sentence, rawText, source) {
	const text = rawText.trim();
	if (!text) return;
	if (findSentenceByText(text, sentence.id)) {
		notify("You already have that sentence — edit cancelled.");
		return;
	}
	editSentence(sentence, text, source);
	sentenceEditId = null;
	notify("");
	changed();
}

function deleteSentence(sentence) {
	const count = linkedWords(sentence.id).length;
	const shared = count > 1 ? "\n\nIt is linked to " + count + " words." : "";
	if (!confirm("Delete this sentence?" + shared)) return;
	removeSentence(sentence.id);
	changed();
}

// --- verb tables ------------------------------------------------------------------

function startConjEdit(word, tense) {
	conjEdit = { id: word.id, tense: tense };
	render();
}

function cancelConjEdit() {
	conjEdit = null;
	render();
}

function saveTense(word, tense, inputs) {
	word.conj[tense] = { source: "yours", forms: inputs.slice(0, 6).map(input => input.value.trim()) };
	if (tense === "present") {
		word.conj.gerund = inputs[6].value.trim();
		word.conj.participle = inputs[7].value.trim();
	}
	word.updatedAt = Date.now();
	conjEdit = null;
	changed();
}

async function resetTense(word, tense, block) {
	if (block.source === "yours" && !confirm("Replace your " + TENSE_LABELS[tense] + " with the dictionary's?")) return;
	const candidates = await dictLookup(word.dict.headword);
	const match = candidates && candidates.find(c => c.headword === word.dict.headword && c.pos === "verb" && c.conj && c.conj[tense]);
	if (!match) {
		notify("The dictionary has no " + TENSE_LABELS[tense] + " for " + word.es + ".");
		return;
	}
	word.conj[tense] = match.conj[tense];
	if (tense === "present") {
		word.conj.gerund = match.conj.gerund || "";
		word.conj.participle = match.conj.participle || "";
	}
	word.updatedAt = Date.now();
	changed();
}

// --- adding words ------------------------------------------------------------------

// Asks the server's dictionary. null = no answer (dictionary not built, or server unreachable).
async function dictLookup(query) {
	try {
		const res = await fetch("/api/dict?q=" + encodeURIComponent(query));
		if (res.status === 503) {
			dictAvailable = false;
			return null;
		}
		if (!res.ok) throw new Error("HTTP " + res.status);
		dictAvailable = true;
		return (await res.json()).candidates;
	} catch (err) {
		return null;
	}
}

// "first-person singular present indicative" → "yo, present"
function describeForm(tags) {
	const t = String(tags || "").split(" ");
	const person = t.includes("first-person") ? 0 : t.includes("second-person") ? 1 : t.includes("third-person") ? 2 : -1;
	const who = person < 0 ? "" : PRONOUNS[person + (t.includes("plural") ? 3 : 0)];
	const what = ["present", "preterite", "imperfect", "future", "conditional", "subjunctive", "imperative", "gerund", "participle", "feminine", "masculine", "plural"]
		.filter(tag => t.includes(tag) && !(who && tag === "plural"));
	return [who, what.join(" ")].filter(Boolean).join(", ") || "a form";
}

function candidateLabel(candidate) {
	return candidate.display + " · " + candidate.pos + (candidate.senses[0] ? " · " + candidate.senses[0] : "");
}

function newWord(es) {
	markActiveDay();
	return {
		id: crypto.randomUUID(), es: es, key: normKey(es), auto: "", autoState: "none", gloss: "", pos: "other", notes: "",
		state: "new", touched: today(), createdAt: Date.now(), updatedAt: Date.now()
	};
}

// Where a just-added word ended up, for the notice. A word that already appears in your
// sentences starts learning straight away.
function landedNote(word) {
	return word.state === "learning" ? " It already appears in your sentences, so it's in learning." : "";
}

function openExisting(existing, raw) {
	const wasArchived = wordState(existing) === "archived";
	showWord(existing);
	notify((normKey(raw) === existing.key
		? '"' + existing.es + '" is already saved — opened it below instead of adding a duplicate.'
		: '"' + raw + '" is "' + existing.es + '", which is already saved — opened it below.')
		+ (wasArchived ? " It was archived; it's back in new." : ""));
}

function addPlainWord(raw) {
	const word = newWord(raw);
	db.words.unshift(word);
	changed();
	showWord(word);
	notify('Saved "' + raw + '".' + landedNote(word));
	translateInto(word, false);
}

function addFromCandidate(candidate, raw) {
	const es = candidate.display;
	const existing = findWordByKey(normKey(es));
	if (existing) {
		openExisting(existing, raw);
		return;
	}
	const word = newWord(es);
	applyDictionary(word, candidate);
	db.words.unshift(word);

	let message = "";
	if (candidate.genderNote) message = 'Saved "' + es + '" — ' + candidate.genderNote + ".";
	else if (candidate.via === "form" && normKey(candidate.form || raw) !== normKey(es)) message = 'Saved "' + es + '" — "' + raw + '" is its ' + describeForm(candidate.formTags) + " form.";
	else if (es.toLowerCase() !== raw.toLowerCase()) message = 'Saved "' + es + '".';
	changed();
	showWord(word);
	notify((message || 'Saved "' + es + '".') + landedNote(word), message ? [{
		label: "Keep " + raw,
		onClick: () => {
			removeWord(word.id);
			notify("");
			addPlainWord(raw);
		}
	}] : []);
	if (!word.dict.senses.length) translateInto(word, false);
}

async function translateInto(word, force) {
	if (word.autoState === "ok" && word.auto && !force) return;
	word.autoState = "pending";
	render();
	try {
		const res = await fetch("/api/translate?q=" + encodeURIComponent(word.es));
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		word.auto = body.text;
		word.autoState = "ok";
	} catch (err) {
		word.autoState = "failed";
	}
	word.updatedAt = Date.now();
	scheduleSave();
	render();
}

// Asks which dictionary entry was meant. onChoose gets the entry, or null for "keep what I typed".
function askWhichWord(raw, candidates, onChoose) {
	const exact = candidates.filter(c => c.via === "headword" || c.via === "form");
	const question = exact.length
		? '"' + raw + '" could be:'
		: 'Nothing called "' + raw + '" — did you mean:';
	notify(question, candidates.map(candidate => ({
		label: candidateLabel(candidate),
		onClick: () => onChoose(candidate)
	})).concat([{ label: "Keep " + raw, onClick: () => onChoose(null) }]));
}

// --- confusing word groups ---------------------------------------------------------

// Works out which word was typed without saving anything: a saved word, one clear dictionary
// answer, the entry picked from the notice, or the text as typed.
async function findOrChoose(raw) {
	const saved = resolveWord(raw);
	if (saved) return { es: saved.es, word: saved };
	const candidates = await dictLookup(raw);
	if (!candidates || !candidates.length) return { es: raw };
	if (candidates.length === 1 && candidates[0].via !== "similar") return { es: candidates[0].display, candidate: candidates[0] };
	return new Promise(resolve => askWhichWord(raw, candidates, candidate => {
		notify("");
		resolve(candidate ? { es: candidate.display, candidate: candidate } : { es: raw });
	}));
}

function savedWordFor(choice) {
	return choice.word || findWordByKey(normKey(choice.es));
}

function saveChoice(choice) {
	const saved = savedWordFor(choice);
	if (saved) return saved;
	const word = newWord(choice.es);
	if (choice.candidate) applyDictionary(word, choice.candidate);
	db.words.unshift(word);
	return word;
}

function translateMissing(words) {
	for (const word of words) if (meaningOf(word).from === "none") translateInto(word, false);
}

function showGroup(group) {
	study = null;
	view = "confusing";
	filter = "";
	el.search.value = "";
	flashId = group.id;
	applyView();
	render();
}

// Nothing is saved unless the words make a new group.
function groupFromChoices(choices, note) {
	if (new Set(choices.map(choice => normKey(choice.es))).size < 2) {
		notify("A group needs at least two different words.");
		return null;
	}
	const known = choices.map(savedWordFor);
	const same = known.every(Boolean) && findGroupWith([...new Set(known)]);
	if (same) {
		showGroup(same);
		notify("You already have that group — it's highlighted below.");
		return null;
	}
	const words = [...new Set(choices.map(saveChoice))];
	const starting = words.filter(word => word.state === "new").map(word => word.es);
	const group = createGroup(words, note);
	changed();
	notify("Group saved: " + words.map(word => word.es).join(" vs ") + "." + (starting.length ? " Now learning: " + starting.join(", ") + "." : ""));
	translateMissing(words);
	return group;
}

function addGroupInput() {
	const count = el.groupInputs.querySelectorAll("input").length;
	if (count) el.groupInputs.append(h("span", { class: "vs" }, "vs"));
	const input = h("input", { list: "wordList", "aria-label": "Word " + (count + 1), placeholder: ["llegar", "llevar"][count] || "another word" });
	input.spellcheck = false;
	el.groupInputs.append(input);
	return input;
}

function resetGroupForm() {
	el.groupInputs.textContent = "";
	addGroupInput();
	addGroupInput();
	el.groupNote.value = "";
}

function startGroupAdd(group) {
	groupAddId = groupAddId === group.id ? null : group.id;
	if (groupAddId) focusSentenceFor = "group-add-" + group.id;
	render();
}

function cancelGroupAdd() {
	groupAddId = null;
	render();
}

async function addTypedToGroup(group, raw) {
	const text = raw.trim();
	if (!text) return;
	const choice = await findOrChoose(text);
	const saved = savedWordFor(choice);
	if (saved && groupWords(group).includes(saved)) {
		notify('"' + saved.es + '" is already in this group.');
		return;
	}
	const word = saveChoice(choice);
	const starting = word.state === "new";
	addToGroup(group, word);
	groupAddId = null;
	changed();
	notify(starting ? '"' + word.es + '" is now learning.' : "");
	translateMissing([word]);
}

function removeGroupWord(group, word) {
	if (groupWords(group).length <= 2 && !confirm("A group needs two words, so this deletes the group. Continue?")) return;
	removeFromGroup(group, word);
	changed();
}

function deleteGroup(group) {
	if (!confirm("Delete this group? The words stay.")) return;
	removeGroup(group.id);
	changed();
}

function startGroupNote(group) {
	groupNoteId = group.id;
	focusSentenceFor = "group-note-" + group.id;
	render();
}

function cancelGroupNote() {
	groupNoteId = null;
	render();
}

function saveGroupNote(group, note) {
	group.note = note.trim();
	group.updatedAt = Date.now();
	groupNoteId = null;
	changed();
}

function startConfusedWith(word) {
	confusedWithId = word.id;
	focusSentenceFor = "confused-" + word.id;
	render();
}

function cancelConfusedWith() {
	confusedWithId = null;
	render();
}

async function addConfusedWith(word, raw) {
	const text = raw.trim();
	if (!text) return;
	const wasNew = word.state === "new";
	const group = groupFromChoices([{ es: word.es, word: word }, await findOrChoose(text)], "");
	if (!group) return;
	confusedWithId = null;
	// Joining moved a new word out of the tab it was open in; follow it.
	if (wasNew) showWord(word);
	else render();
}

// --- checking existing words against the dictionary ---------------------------------------

// Everything that only adds information is applied straight away. Anything that would rename or
// merge a word goes on the review list.
async function checkAgainstDictionary() {
	const words = db.words.filter(word => word.dictReview !== "skipped");
	notify("Checking " + words.length + " words against the dictionary…");
	let filled = 0;
	const items = [];
	for (const word of words) {
		const candidates = await dictLookup(word.es);
		if (candidates === null && !dictAvailable) {
			notify("The dictionary isn't built yet — see README, section Dictionary.");
			return;
		}
		if (!candidates || !candidates.length) continue;
		// Filled in silently only when there is nothing to decide: the one answer has the same
		// spelling (accents included), or the word's part of speech picks out exactly one.
		// "claro" (adjective, adverb, interjection) or "como" next to "cómo" are asked about.
		const same = candidates.filter(c => c.via === "headword" && !c.genderNote && c.display.toLowerCase() === word.es.toLowerCase());
		const byPos = word.pos && word.pos !== "other" ? same.filter(c => c.pos === word.pos) : [];
		const pick = same.length === candidates.length && (same.length === 1 ? same[0] : byPos.length === 1 ? byPos[0] : null);
		if (pick) {
			applyDictionary(word, pick);
			filled++;
			continue;
		}
		items.push({ wordId: word.id, candidates: candidates });
	}
	reviewItems = items;
	if (items.length) setView("review");
	changed();
	notify("Filled in " + plural(filled, "word") + " from the dictionary. "
		+ (items.length ? items.length + " need a decision below." : "Nothing needs a decision."));
}

function finishReviewItem(item) {
	reviewItems = reviewItems.filter(other => other !== item);
	if (!reviewItems.length) {
		notify("Review done.");
		view = "new";
		applyView();
	}
	changed();
}

function acceptReview(item, candidate) {
	const word = db.words.find(other => other.id === item.wordId);
	if (!word) return finishReviewItem(item);
	const target = findWordByKey(normKey(candidate.display));
	if (target && target !== word) {
		mergeWordInto(word, target);
		applyDictionary(target, candidate);
	} else {
		word.es = candidate.display;
		word.key = normKey(candidate.display);
		applyDictionary(word, candidate);
		delete word.dictReview;
	}
	finishReviewItem(item);
}

function skipReview(item, word) {
	word.dictReview = "skipped";
	finishReviewItem(item);
}

// --- flashcards ------------------------------------------------------------------

// One session for everything due, learning and learned together. With nothing due it is practice
// over the learning words (or the learned ones, if learning is empty); practice still counts.
function startStudy() {
	const due = dueWords("learning").concat(dueWords("learned"));
	const pool = due.length ? due : wordsIn("learning").length ? wordsIn("learning") : wordsIn("learned");
	const queue = shuffled(pool).filter(word => cardFor(word)).map(word => word.id);
	if (!queue.length) {
		notify("None of these words can make a card yet: each needs a meaning or a sentence.");
		return;
	}
	study = {
		back: view === "study" ? "learning" : view, practice: !due.length, queue: queue, position: 0, flipped: false, card: null, picked: null,
		retries: new Map(), knew: 0, missed: new Set(), learned: [], lapsed: []
	};
	study.card = cardFor(db.words.find(word => word.id === queue[0]));
	view = "study";
	notify("");
	applyView();
	render();
	window.scrollTo(0, 0);
}

function endStudy() {
	view = study ? study.back : "learning";
	study = null;
	applyView();
	render();
}

function flip() {
	if (!study || !study.card || study.flipped) return;
	study.flipped = true;
	render();
}

function pick(word) {
	if (!study || !study.card || study.flipped) return;
	study.picked = word;
	study.flipped = true;
	render();
}

// A missed card comes back at the end of the session, at most twice. Group mates reset by a missed
// "which" card don't join this session; they are due now, so the next one picks them up.
function answer(knew) {
	if (!study || !study.card || !study.flipped) return;
	const card = study.card;
	const word = card.word;
	const result = grade(word, knew);
	if (knew) study.knew++; else study.missed.add(word.id);
	if (result === "learned") study.learned.push(word.es);
	if (result === "lapsed") study.lapsed.push(word.es);
	if (!knew && card.type === "which") {
		for (const reset of resetGroup(card.group, word)) {
			study.missed.add(reset.word.id);
			if (reset.lapsed) study.lapsed.push(reset.word.es);
		}
	}
	if (!knew && (study.retries.get(word.id) || 0) < 2) {
		study.retries.set(word.id, (study.retries.get(word.id) || 0) + 1);
		study.queue.push(word.id);
	}
	scheduleSave();
	study.position++;
	study.flipped = false;
	study.picked = null;
	const next = study.queue[study.position];
	study.card = next ? cardFor(db.words.find(other => other.id === next)) : null;
	render();
}

// --- views ------------------------------------------------------------------

function applyView() {
	const words = ["new", "learning", "learned", "archive"].includes(view);
	const studying = view === "study";
	el.tabs.hidden = studying;
	el.footer.hidden = studying;
	el.tools.hidden = !words;
	el.sentenceForm.hidden = view !== "sentences";
	el.groupForm.hidden = view !== "confusing";
	// On these two tabs the search box sits under the tab's own form instead of next to Add.
	if (view === "sentences") el.sentenceForm.after(el.searchBox);
	else if (view === "confusing") el.groupForm.after(el.searchBox);
	else el.tools.append(el.searchBox);
	el.searchBox.hidden = !words && view !== "sentences" && view !== "confusing";
	el.search.placeholder = { sentences: "Search sentences…", confusing: "Search groups…", new: "Search new words…" }[view] || "Search " + view + "…";
}

function setView(next) {
	if (view === next) return;
	study = null;
	view = next;
	notify("");
	applyView();
	render();
	// Only with a mouse: on a phone, focusing would pop the keyboard up on every tab change.
	if (!matchMedia("(pointer: fine)").matches) return;
	if (view === "sentences") el.sentenceInput.focus();
	else if (view === "confusing") el.groupInputs.querySelector("input").focus();
	else if (view !== "review") el.addInput.focus();
}

el.studyNow.addEventListener("click", () => startStudy());

el.addForm.addEventListener("submit", async e => {
	e.preventDefault();
	const raw = el.addInput.value.trim();
	if (!raw) return;
	el.addInput.value = "";
	el.addInput.focus();

	const existing = findWordByKey(normKey(raw));
	if (existing) {
		openExisting(existing, raw);
		return;
	}

	const candidates = await dictLookup(raw);
	if (!candidates || !candidates.length) {
		addPlainWord(raw);
		if (!dictAvailable) notify("Saved as typed — the dictionary isn't built yet, so this uses machine translation.");
		return;
	}

	// One clear answer is saved straight away; anything else is a choice, and nothing is saved
	// until you pick.
	if (candidates.length === 1 && candidates[0].via !== "similar") {
		addFromCandidate(candidates[0], raw);
		return;
	}
	askWhichWord(raw, candidates, candidate => {
		if (candidate) {
			addFromCandidate(candidate, raw);
		} else {
			notify("");
			addPlainWord(raw);
		}
	});
});

resetGroupForm();
document.getElementById("addGroupInput").addEventListener("click", () => addGroupInput().focus());

el.groupForm.addEventListener("submit", async e => {
	e.preventDefault();
	const raws = [...el.groupInputs.querySelectorAll("input")].map(input => input.value.trim()).filter(Boolean);
	if (raws.length < 2) {
		notify("A group needs at least two different words.");
		return;
	}
	const note = el.groupNote.value;
	const choices = [];
	for (const raw of raws) choices.push(await findOrChoose(raw));
	const group = groupFromChoices(choices, note);
	if (!group) return;
	resetGroupForm();
	showGroup(group);
	el.groupInputs.querySelector("input").focus();
});

el.sentenceForm.addEventListener("submit", e => {
	e.preventDefault();
	const text = el.sentenceInput.value.trim();
	if (!text) return;

	const existing = findSentenceByText(text);
	if (existing) {
		notify("You already have that sentence — it's highlighted below.");
		filter = "";
		el.search.value = "";
		flashId = existing.id;
		render();
		return;
	}

	const sentence = createSentence(text, el.sentenceSource.value);
	el.sentenceInput.value = "";
	el.sentenceSource.value = "";
	el.sentenceInput.focus();
	const started = changed();

	const words = linkedWords(sentence.id).map(word => word.es);
	notify((words.length
		? "Linked to " + words.join(", ") + "."
		: "Saved. None of your words appear in it yet — it will link up as you add them.")
		+ (started.length ? " Started learning: " + started.map(word => word.es).join(", ") + "." : ""));
});

el.sentenceInput.addEventListener("keydown", e => {
	if (e.key !== "Enter" || e.shiftKey) return;
	e.preventDefault();
	el.sentenceForm.requestSubmit();
});

el.search.addEventListener("input", e => { filter = e.target.value; render(); });

// A day counts on the clock once you use the site: its first click or key press. Marking happens
// before the click's own handler runs, so whatever you clicked already sees the new day. Nothing
// is marked or saved before the file has loaded, or a click during loading would save an empty file.
function noteActivity() {
	if (!loaded || loadFailed) return;
	const before = today();
	markActiveDay();
	if (today() === before) return;
	dayTurned = true;
	scheduleSave();
}
document.addEventListener("pointerdown", noteActivity, true);
document.addEventListener("keydown", noteActivity, true);
// The first click of a day may change what is due or archived; redraw once it has been handled.
document.addEventListener("click", () => {
	if (!dayTurned) return;
	dayTurned = false;
	render();
});

document.addEventListener("keydown", e => {
	const tag = document.activeElement.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	if (view === "study" && study) {
		if (e.key === "Escape") endStudy();
		else if (study.card && study.card.type === "which") {
			const choice = study.card.choices[Number(e.key) - 1];
			if (e.key === " ") e.preventDefault();
			if (!study.flipped && choice) pick(choice);
			else if (study.flipped && (e.key === " " || e.key === "Enter")) answer(study.picked === study.card.word);
		}
		else if ((e.key === " " || e.key === "Enter") && !study.flipped) { e.preventDefault(); flip(); }
		else if (e.key === "1") answer(false);
		else if (e.key === "2") answer(true);
		return;
	}
	if (e.key === "/" && !el.searchBox.hidden) {
		e.preventDefault();
		el.search.focus();
	}
});

document.getElementById("checkBtn").addEventListener("click", () => checkAgainstDictionary());

document.getElementById("exportBtn").addEventListener("click", () => {
	const blob = new Blob([snapshot()], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "vocab-" + new Date().toISOString().slice(0, 10) + ".json";
	a.click();
	URL.revokeObjectURL(a.href);
});

document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());

document.getElementById("importFile").addEventListener("change", async e => {
	const file = e.target.files[0];
	if (!file) return;
	e.target.value = "";
	let incoming;
	try {
		incoming = loadAny(JSON.parse(await file.text())).db;
	} catch (err) {
		notify("That file isn't a vocab export.");
		return;
	}
	const result = mergeDb(incoming);
	notify("Imported " + plural(result.addedWords, "new word") + " (" + result.skippedWords + " already saved) and "
		+ plural(result.addedSentences, "new sentence") + ".");
	changed();
});

function conversionNotice(loadResult) {
	const lines = [];
	if (loadResult.renamed.length) lines.push("saved under the infinitive: " + loadResult.renamed.map(entry => entry.from + " → " + entry.to).join(", "));
	if (loadResult.merged.length) lines.push("folded into the verb already saved: " + loadResult.merged.map(entry => entry.from + " → " + entry.to).join(", "));
	if (!lines.length) return;
	const undoRename = loadResult.renamed.map(entry => ({
		label: "Keep " + entry.from,
		onClick: () => {
			entry.word.es = entry.from;
			entry.word.key = normKey(entry.from);
			entry.word.pos = "other";
			delete entry.word.conj;
			notify("");
			changed();
		}
	}));
	const undoMerge = loadResult.merged.map(entry => ({
		label: "Keep " + entry.from,
		onClick: () => {
			entry.word.pos = "other";
			delete entry.word.conj;
			db.words.unshift(entry.word);
			notify("");
			changed();
		}
	}));
	notify(lines.join("; ") + ".", undoRename.concat(undoMerge));
}

(async function start() {
	let loadResult;
	try {
		// no-store, or a reload can be handed a stale body.
		const res = await fetch("/api/vocab", { cache: "no-store" });
		if (!res.ok) throw new Error("HTTP " + res.status);
		fileTime = res.headers.get("X-File-Time");
		loadResult = loadAny(await res.json());
		setState("saved", "Saved");
	} catch (err) {
		loadFailed = true;
		loadResult = { db: emptyDb(), renamed: [], merged: [], converted: false };
		setState("unsaved", "Cannot reach server");
		notify("Could not load vocab.json — is the server running? Nothing you type here will be saved until you reload.");
	}
	db = loadResult.db;
	relink();
	const migrated = initLearning();
	if (loadResult.converted || migrated) scheduleSave();

	const pending = localStorage.getItem(PENDING_KEY);
	if (pending && !loadFailed) {
		let parsed = null;
		try { parsed = JSON.parse(pending); } catch (_) {}
		// Changes held from before the file last changed would roll it back, the same as a save from
		// an out-of-date tab, so they are dropped.
		const stale = !(Number(localStorage.getItem(PENDING_TIME_KEY)) >= Number(fileTime));
		if (parsed && !stale && pending !== snapshot() && confirm("There are unsaved changes from last time. Restore them?")) {
			try {
				db = loadAny(parsed).db;
				relink();
				initLearning();
				scheduleSave();
			} catch (_) {}
		} else {
			clearPending();
			if (stale) notify("Unsaved changes from an older tab were not restored, because newer data has been saved since.");
		}
	}

	refreshWordList();
	applyView();
	render();
	loaded = !loadFailed;
	conversionNotice(loadResult);
	if (migrated) {
		const count = state => wordsIn(state).length;
		notify("Learning is set up: " + count("learning") + " words with sentences are in learning, " + count("new") + " are new, and "
			+ count("archived") + " are archived (not opened for " + ARCHIVE_AFTER + " active days — they're in the archive tab, nothing is deleted).");
	}
})();
