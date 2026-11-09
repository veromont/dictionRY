// Drawing the screen. Every function here builds elements from the current state; what the
// buttons do lives in app.js.

const VIEW_OF_STATE = { new: "new", learning: "learning", learned: "learned", archived: "archive" };
const TABS = [["new", "New"], ["learning", "Learning"], ["learned", "Learned"], ["archive", "Archive"], ["confusing", "Confusing"], ["sentences", "Sentences"]];
const ICON_PATHS = { chevron: "M6 9l6 6 6-6", back: "M15 18l-6-6 6-6" };

// h("button", { class: "btn", onclick: fn }, "Save") → <button class="btn">Save</button>
function h(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === null || value === undefined || value === false) continue;
		if (key === "class") node.className = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (key.includes("-") || key === "list" || !(key in node)) node.setAttribute(key, value);
		else node[key] = value;
	}
	for (const child of children.flat(Infinity)) {
		if (child !== null && child !== undefined && child !== false && child !== "") node.append(child);
	}
	return node;
}

function btn(label, onClick, className, attrs) {
	return h("button", Object.assign({ type: "button", class: className, onclick: onClick }, attrs), label);
}

function icon(name) {
	const holder = document.createElement("span");
	holder.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + ICON_PATHS[name] + '"/></svg>';
	return holder.firstChild;
}

function plural(n, word) {
	return n + " " + word + (n === 1 ? "" : "s");
}

function wordsIn(state) {
	return db.words.filter(word => wordState(word) === state);
}

function dueOf(word) {
	return word.review ? word.review.due : today();
}

function streakOf(word) {
	return Math.min(word.review ? word.review.streak : 0, LEARNED_AFTER);
}

function dueText(word) {
	if (!word.review) return "";
	const wait = word.review.due - today();
	return wait <= 0 ? "due now" : wait === 1 ? "next active day" : "in " + plural(wait, "active day");
}

function matchesSearch(word, q) {
	return !q || [word.es, word.gloss, word.auto, word.notes, meaningOf(word).text]
		.concat(linkedSentences(word.id).map(sentence => sentence.text + " " + sentence.source))
		.some(value => normKey(value).includes(q));
}

function noMatch() {
	return "No words match “" + filter.trim() + "”.";
}

function empty(message) {
	el.content.append(h("p", { class: "empty" }, message));
}

function dots(filled) {
	const list = [];
	for (let i = 0; i < LEARNED_AFTER; i++) list.push(h("span", { class: "dot" + (i < filled ? " on" : "") }));
	return h("div", { class: "dots", "aria-hidden": "true" }, list);
}

function meaningEl(word, tag, className) {
	const meaning = meaningOf(word);
	if (meaning.from === "pending") return h(tag, { class: className + " pending" }, "translating…");
	if (meaning.from === "none") return h(tag, { class: className + " failed" }, "no translation");
	return h(tag, { class: className }, meaning.text);
}

function posChip(word) {
	return word.pos && word.pos !== "other" ? h("span", { class: "chip" }, word.pos + (word.gender ? " · " + word.gender : "")) : null;
}

function autoChip(word) {
	return meaningOf(word).from === "machine" ? h("span", { class: "auto", title: "Meaning filled in automatically — worth a check" }, "AUTO") : null;
}

function notesEl(word) {
	return (word.notes || "").trim() && editingId !== word.id ? h("p", { class: "note" }, word.notes) : null;
}

function hasForms(word) {
	return Boolean(word.conj && word.conj.present);
}

// "vs llevar, lavar": every word this one shares a group with.
function vsText(word) {
	const others = [...new Set(groupsOf(word).flatMap(groupWords))].filter(other => other !== word);
	return others.length ? "vs " + others.map(other => other.es).join(", ") : "";
}

// Highlights the saved words in a sentence. With `focus`, that word stands out and the other
// saved words are only underlined.
function sentenceNode(sentence, words, focus) {
	const linked = new Set(words.map(word => word.id));
	// A multi-word entry ("claro que si") is highlighted word by word.
	const partsOf = list => new Set(list.filter(word => (word.key || "").includes(" ")).flatMap(word => word.key.split(" ")));
	const phraseParts = partsOf(words);
	const focusParts = focus ? partsOf([focus]) : new Set();
	const text = sentence.text;
	const frag = document.createDocumentFragment();
	// WORDS_IN_TEXT (text.js) matches one word at a time, the same way the linker reads sentences.
	const re = new RegExp(WORDS_IN_TEXT.source, "gu");
	let last = 0;
	let match;
	while ((match = re.exec(text))) {
		const ids = tokenWordIds(linkState.index, match[0]);
		const key = normKey(match[0]);
		const isFocus = focus && (ids.has(focus.id) || focusParts.has(key));
		if (!isFocus && ![...ids].some(id => linked.has(id)) && !phraseParts.has(key)) continue;
		if (match.index > last) frag.append(text.slice(last, match.index));
		frag.append(h("span", { class: !focus || isFocus ? "hl" : "ul" }, match[0]));
		last = match.index + match[0].length;
	}
	if (last < text.length) frag.append(text.slice(last));
	return frag;
}

function render() {
	el.count.textContent = plural(db.words.length, "word") + " · " + plural(db.sentences.length, "sentence");
	renderTabs();
	renderStudyNow();
	el.content.textContent = "";
	const q = normKey(filter);
	if (view === "review") renderReview();
	else if (view === "study") renderStudy();
	else if (view === "sentences") renderSentences(q);
	else if (view === "confusing") renderConfusing(q);
	else if (view === "learning") renderLearning(q);
	else if (view === "learned") renderLearned(q);
	else renderRows(view, q);

	if (flashId) {
		const target = el.content.querySelector('[data-id="' + flashId + '"]');
		if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
		flashId = null;
	}
	if (focusSentenceFor) {
		const box = el.content.querySelector('[data-focus="' + focusSentenceFor + '"]');
		if (box) box.focus();
		focusSentenceFor = null;
	}
}

function renderTabs() {
	const counts = { new: 0, learning: 0, learned: 0, archive: 0, confusing: db.groups.length, sentences: db.sentences.length };
	for (const word of db.words) counts[VIEW_OF_STATE[wordState(word)]]++;
	el.tabs.textContent = "";
	for (const [name, label] of TABS) {
		const on = view === name;
		el.tabs.append(btn([label, h("span", { class: "n" }, String(counts[name]))], () => setView(name), "tab" + (on ? " on" : ""), { "aria-pressed": String(on) }));
	}
}

function renderStudyNow() {
	const due = dueWords("learning").length + dueWords("learned").length;
	const any = db.words.some(word => word.state === "learning" || word.state === "learned");
	el.studyNow.hidden = view === "study" || !any;
	el.studyNow.classList.toggle("plain", !due);
	el.studyNow.textContent = "";
	el.studyNow.append(due ? "Study now" : "Practice", due ? h("span", { class: "pill" }, due + " due") : "");
}

// --- learning ------------------------------------------------------------------

function stat(label, value, tone) {
	return h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" + (tone ? " " + tone : "") }, String(value)));
}

function renderLearning(q) {
	const all = wordsIn("learning").sort((a, b) => dueOf(a) - dueOf(b) || (b.createdAt || 0) - (a.createdAt || 0));
	const visible = all.filter(word => matchesSearch(word, q));
	el.content.append(h("div", { class: "stats" },
		stat("Due now", dueWords("learning").length, "accent"),
		stat("On a streak", all.filter(word => streakOf(word) > 0).length),
		stat("Learned", wordsIn("learned").length, "good"),
		h("div", { class: "stat-hint" }, dots(LEARNED_AFTER), h("span", null, "Right on " + LEARNED_AFTER + " different days in a row → the word moves to Learned."))));
	if (!visible.length) {
		empty(all.length ? noMatch() : "Nothing in learning yet. A word starts learning when it gets its first sentence, or with Start learning in New.");
		return;
	}
	el.content.append(h("div", { class: "grid" }, visible.map(wordCard)));
}

// A learning word, or a learned one opened from its tile.
function wordCard(word) {
	const open = openId === word.id;
	const sentences = linkedSentences(word.id);
	const due = dueText(word);
	const first = sentences[0];
	return h("article", { class: "card" + (open ? " open" : "") + (word.id === flashId ? " flash" : ""), "data-id": word.id },
		h("div", { class: "card-head" },
			btn(word.es, () => toggleOpen(word), "card-word", { "aria-expanded": String(open) }),
			h("div", { class: "card-tags" }, autoChip(word), posChip(word),
				btn(icon("chevron"), () => toggleOpen(word), "chevron", { "aria-label": (open ? "Hide" : "Show") + " details for " + word.es }))),
		meaningEl(word, "p", "meaning"),
		!open && vsText(word) ? h("p", { class: "vs-line" }, vsText(word)) : null,
		!first ? h("p", { class: "no-sentence" }, "No sentence yet — add one where you met it.")
			: open ? sentenceBlock(first, word, true)
			: h("p", { class: "sentence-box" }, sentenceNode(first, linkedWords(first.id), word)),
		h("div", { class: "card-foot" },
			h("div", { class: "progress" }, dots(streakOf(word)), wordState(word) === "learned" ? "learned" : streakOf(word) + " of " + LEARNED_AFTER),
			h("span", { class: "due" + (due === "due now" ? " now" : "") }, due)),
		notesEl(word),
		open ? wordDetails(word, sentences.slice(1), "Also seen in") : null);
}

function stateActions(word) {
	const state = wordState(word);
	if (state === "learning") return [btn("Mark learned", () => moveTo(word, "learned"), "btn good"), btn("Back to new", () => moveTo(word, "new"), "btn")];
	if (state === "learned") return [btn("Back to learning", () => moveTo(word, "learning"), "btn")];
	return [];
}

// The open part of a card or row: actions, editor, verb tables, sentences and the sentence box.
function wordDetails(word, sentences, label) {
	return h("div", { class: "details" },
		h("div", { class: "actions" },
			stateActions(word),
			hasForms(word) ? btn(formsOpen.has(word.id) ? "Hide forms" : "Forms", () => toggleForms(word), "btn") : null,
			btn("Edit", () => toggleEdit(word), "btn"),
			btn("Delete", () => deleteWord(word), "btn bad")),
		editingId === word.id ? editor(word) : null,
		hasForms(word) && formsOpen.has(word.id) ? conjugationBlock(word) : null,
		confusedSection(word),
		sentences.length ? h("div", { class: "sentence-list" }, h("div", { class: "section-label" }, label), sentences.map(sentence => sentenceBlock(sentence, word))) : null,
		sentenceComposer(word));
}

function confusedSection(word) {
	const groups = groupsOf(word);
	return h("div", { class: "confused" },
		groups.length ? h("div", { class: "section-label" }, "Confused with") : null,
		groups.map(group => h("div", { class: "sent-meta" },
			groupWords(group).filter(other => other !== word).map(other => h("span", { class: "word-chip" }, btn(other.es, () => openWord(other)))),
			group.note ? h("span", { class: "sent-source" }, group.note) : null,
			btn("Leave group", () => removeGroupWord(group, word), "link-btn bad"))),
		confusedWithId === word.id
			? wordBox("Type a word", "confused-" + word.id, "Add", value => addConfusedWith(word, value), cancelConfusedWith)
			: btn("+ confused with", () => startConfusedWith(word), "link-btn"));
}

// A sentence inside a word's details. `word` is the word it is shown under, so its own chip is
// not repeated back at it.
function sentenceBlock(sentence, word, boxed) {
	if (sentenceEditId === sentence.id) return sentenceEditor(sentence);
	const words = linkedWords(sentence.id);
	return h("div", { class: boxed ? "sentence-box" : "sent" },
		h("p", { class: boxed ? null : "sent-text" }, sentenceNode(sentence, words, word)),
		h("div", { class: "sent-meta" },
			sentence.source ? h("span", { class: "sent-source" }, sentence.source) : null,
			words.filter(other => other !== word).map(other => linkChip(sentence, other)),
			sentenceActions(sentence, word)),
		linkingId === sentence.id ? linkBox(sentence) : null);
}

function sentenceActions(sentence, word) {
	return [
		btn("+ word", () => toggleLinking(sentence), "link-btn"),
		btn("Edit", () => startSentenceEdit(sentence), "link-btn"),
		word ? btn("Unlink", () => unlink(sentence, word), "link-btn") : null,
		btn("Delete", () => deleteSentence(sentence), "link-btn bad")
	];
}

// A linked word on a sentence: click the word to open it, × to unlink it here.
function linkChip(sentence, word) {
	const manual = isManualLink(sentence.id, word.id);
	return h("span", { class: "word-chip" + (manual ? " manual" : "") },
		btn(word.es, () => openWord(word), null, { title: manual ? "Linked by hand" : "Found in the text" }),
		btn("×", () => unlink(sentence, word), null, { "aria-label": "Unlink " + word.es + " from this sentence", title: "Unlink " + word.es }));
}

function wordBox(placeholder, focusKey, label, onCommit, onCancel) {
	const input = h("input", {
		class: "inset-input", list: "wordList", placeholder: placeholder, "data-focus": focusKey,
		onkeydown: e => {
			if (e.key === "Enter") { e.preventDefault(); onCommit(input.value); }
			if (e.key === "Escape") onCancel();
		}
	});
	return h("div", { class: "link-box" }, input, btn(label, () => onCommit(input.value), "btn"), btn("Cancel", onCancel, "btn"));
}

function linkBox(sentence) {
	return wordBox("Link a saved word", "link-" + sentence.id, "Link", value => linkTyped(sentence, value), cancelLinking);
}

function sentenceEditor(sentence) {
	const text = h("textarea", { rows: 2, value: sentence.text, "data-focus": "edit-" + sentence.id });
	const source = h("input", { value: sentence.source || "", placeholder: "show, book, friend…" });
	const save = () => saveSentenceEdit(sentence, text.value, source.value);
	return h("div", {
		class: "edit-form",
		onkeydown: e => {
			if (e.key === "Enter" && !e.shiftKey && e.target === text) { e.preventDefault(); save(); }
			if (e.key === "Escape") cancelSentenceEdit();
		}
	},
		h("label", { class: "field" }, "Sentence", text),
		h("label", { class: "field" }, "Source (optional)", source),
		h("div", { class: "actions" }, btn("Save", save, "btn solid"), btn("Cancel", cancelSentenceEdit, "btn")));
}

// What you type here survives redraws (a translation arriving, a save) until it is added.
function sentenceComposer(word) {
	const draft = drafts.get(word.id) || { text: "", source: "" };
	const keep = () => drafts.set(word.id, { text: text.value, source: source.value });
	const add = () => addSentenceFor(word, text.value, source.value);
	const text = h("textarea", {
		rows: 2, value: draft.text, "data-focus": "add-" + word.id, oninput: keep,
		onkeydown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } }
	});
	const source = h("input", { value: draft.source, placeholder: "show, book, friend…", oninput: keep });
	return h("div", { class: "sentence-list" },
		h("div", { class: "compose" }, h("label", { class: "field" }, "Sentence you met it in", text), h("label", { class: "field" }, "Source (optional)", source)),
		h("div", { class: "compose-bar" }, h("span", null, "Other saved words in it get linked too."), btn("Add sentence", add, "btn solid")));
}

function editor(word) {
	const suggested = word.dict && word.dict.senses.length ? "dictionary: " + word.dict.senses.slice(0, 3).join("; ") : word.auto ? "machine says: " + word.auto : "";
	const gloss = h("input", { value: word.gloss || "", placeholder: "Leave empty to show the meaning above", "data-focus": "gloss-" + word.id });
	const es = h("input", { value: word.es });
	const pos = h("select", null, (POS_OPTIONS.includes(word.pos) ? POS_OPTIONS : POS_OPTIONS.concat(word.pos || [])).map(value => h("option", { value: value }, value)));
	pos.value = word.pos || "other";
	const notes = h("textarea", { rows: 2, value: word.notes || "" });
	const save = () => saveWordEdit(word, { es: es.value, gloss: gloss.value, pos: pos.value, notes: notes.value });
	return h("div", {
		class: "edit-form",
		onkeydown: e => {
			if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); save(); }
			if (e.key === "Escape") closeEdit();
		}
	},
		h("label", { class: "field" }, suggested ? "Your meaning (" + suggested + ")" : "Your meaning", gloss),
		h("div", { class: "edit-row" }, h("label", { class: "field" }, "Spanish", es), h("label", { class: "field" }, "Part of speech", pos)),
		h("label", { class: "field" }, "Notes", notes),
		h("div", { class: "actions" }, btn("Save", save, "btn solid"), btn("Cancel", closeEdit, "btn")));
}

function conjugationBlock(word) {
	const tenses = TENSES.filter(tense => word.conj[tense] && Array.isArray(word.conj[tense].forms));
	const all = moreTenses.has(word.id);
	return h("div", { class: "conj" },
		(all ? tenses : tenses.slice(0, 1)).map(tense => tenseBlock(word, tense, word.conj[tense])),
		tenses.length > 1 ? h("div", null, btn(all ? "Fewer tenses" : "More tenses (" + (tenses.length - 1) + ")", () => toggleMoreTenses(word), "btn")) : null);
}

function tenseBlock(word, tense, block) {
	const editing = conjEdit && conjEdit.id === word.id && conjEdit.tense === tense;
	// Singular down the left column, plural down the right, the way conjugation tables read.
	const order = [0, 3, 1, 4, 2, 5].map(i => [PRONOUNS[i], block.forms[i], i]);
	if (tense === "present") order.push(["gerund", word.conj.gerund || "", 6], ["participle", word.conj.participle || "", 7]);
	const inputs = [];
	const cells = order.map(([who, form, index]) => {
		const value = editing ? (inputs[index] = h("input", { value: form || "" })) : h("span", null, form);
		return h("div", { class: "conj-cell" }, h("span", { class: "who" }, who), value);
	});
	const sourceTitle = block.source === "yours" ? "You corrected these"
		: block.source === "dictionary" ? "From Wiktionary"
		: "Built by the old rules engine — run Check against dictionary to replace it";
	return h("div", { class: "tense" },
		h("div", { class: "tense-head" },
			h("span", { class: "tense-title" }, TENSE_LABELS[tense]),
			h("span", { class: "source-tag", title: sourceTitle }, block.source),
			editing ? null : btn("Edit", () => startConjEdit(word, tense), "link-btn"),
			editing || !word.dict ? null : btn("Reset", () => resetTense(word, tense, block), "link-btn")),
		h("div", { class: "conj-grid" }, cells),
		editing ? h("div", { class: "actions" }, btn("Save", () => saveTense(word, tense, inputs), "btn solid"), btn("Cancel", cancelConjEdit, "btn")) : null);
}

// --- new and archive ---------------------------------------------------------------

function renderRows(name, q) {
	const state = name === "archive" ? "archived" : "new";
	const all = wordsIn(state);
	const visible = all.filter(word => matchesSearch(word, q));
	el.content.append(h("p", { class: "intro" }, state === "new"
		? "Words you've saved but not started. Start one when you've found a sentence for it."
		: "Words you haven't opened for " + ARCHIVE_AFTER + " active days. Nothing is deleted — restore any time."));
	if (!visible.length) {
		empty(all.length ? noMatch() : state === "new" ? "Nothing new. Type a word above." : "Nothing archived.");
		return;
	}
	el.content.append(h("div", { class: "rows" + (state === "archived" ? " archive" : "") }, visible.map(word => wordRow(word, state === "archived"))));
}

function wordRow(word, archived) {
	const open = !archived && openId === word.id;
	const count = linkedSentences(word.id).length;
	return h("div", { class: "row-wrap" + (word.id === flashId ? " flash" : ""), "data-id": word.id },
		h("div", { class: "row" },
			h("div", { class: "row-main" },
				btn(word.es, () => archived ? restoreWord(word) : toggleOpen(word), "row-word", archived ? { title: "Restore" } : { "aria-expanded": String(open) }),
				meaningEl(word, "span", "row-meaning")),
			h("div", { class: "row-side" },
				autoChip(word),
				posChip(word),
				count ? h("span", { class: "chip" }, plural(count, "sentence")) : null,
				vsText(word) ? h("span", { class: "chip" }, vsText(word)) : null,
				archived ? [btn("Mark learned", () => moveTo(word, "learned"), "btn good"), btn("Restore", () => restoreWord(word), "btn")] : btn("Start learning →", () => moveTo(word, "learning"), "btn start")),
			!archived && archivesIn(word) <= 1 ? h("span", { class: "row-warn" }, "Archives on your next active day unless opened") : null,
			notesEl(word)),
		open ? wordDetails(word, linkedSentences(word.id), "Seen in") : null);
}

// --- learned ---------------------------------------------------------------------

function renderLearned(q) {
	const all = wordsIn("learned").sort((a, b) => dueOf(a) - dueOf(b));
	if (!all.length) {
		const due = dueWords("learning").length;
		el.content.append(h("div", { class: "learned-empty" },
			h("div", { class: "dots", "aria-hidden": "true" }, h("span", { class: "dot on" }), h("span", { class: "dot" }), h("span", { class: "dot" })),
			h("h2", null, "Nothing learned yet"),
			h("p", null, "A word lands here after you get it right on " + LEARNED_AFTER + " different days in a row."),
			due ? btn("Study " + plural(due, "due word"), () => startStudy(), "pill-btn")
				: wordsIn("learning").length ? btn("Practice learning words", () => startStudy(), "pill-btn") : null));
		return;
	}
	const visible = all.filter(word => matchesSearch(word, q));
	if (!visible.length) {
		empty(noMatch());
		return;
	}
	el.content.append(h("div", { class: "tiles" }, visible.map(word => openId === word.id ? wordCard(word) : learnedTile(word))));
}

function learnedTile(word) {
	const due = dueText(word);
	return btn([
		h("span", { class: "tile-word" }, word.es),
		meaningEl(word, "span", "tile-meaning"),
		h("span", { class: "tile-due" }, due === "due now" ? due : "review " + due)
	], () => toggleOpen(word), "tile" + (word.id === flashId ? " flash" : ""), { "data-id": word.id, "aria-expanded": "false" });
}

// --- sentences -------------------------------------------------------------------

function renderSentences(q) {
	const all = db.sentences.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	const visible = q
		? all.filter(sentence => normKey(sentence.text + " " + sentence.source).includes(q)
			|| linkedWords(sentence.id).some(word => normKey(word.es).includes(q) || normKey(word.gloss || word.auto).includes(q)))
		: all;
	if (!visible.length) {
		empty(all.length ? "No sentences match “" + filter.trim() + "”." : "No sentences yet. Paste one above, or open a word and add it there.");
		return;
	}
	el.content.append(h("div", { class: "sentences" }, visible.map(sentenceCard)));
}

function sentenceCard(sentence) {
	if (sentenceEditId === sentence.id) return sentenceEditor(sentence);
	const words = linkedWords(sentence.id);
	return h("article", { class: "sentence-card" + (sentence.id === flashId ? " flash" : ""), "data-id": sentence.id },
		h("p", { class: "sent-text" }, sentenceNode(sentence, words)),
		h("div", { class: "word-chips" }, words.length ? words.map(word => linkChip(sentence, word)) : h("span", { class: "unlinked" }, "None of your words appear in it yet")),
		linkingId === sentence.id ? linkBox(sentence) : null,
		h("div", { class: "sent-meta" }, sentence.source ? h("span", { class: "sent-source" }, sentence.source) : null, sentenceActions(sentence, null)));
}

// --- confusing words -------------------------------------------------------------

function renderConfusing(q) {
	const visible = db.groups.filter(group => !q || normKey(group.note).includes(q)
		|| groupWords(group).some(word => normKey(word.es).includes(q) || normKey(meaningOf(word).text).includes(q)));
	el.content.append(h("p", { class: "intro" }, "Words you mix up, side by side. Flashcards ask which is which, and a miss there resets the whole group."));
	if (!visible.length) {
		empty(db.groups.length ? "No groups match “" + filter.trim() + "”." : "No groups yet. Add two words you mix up above.");
		return;
	}
	el.content.append(h("div", { class: "groups" }, visible.map(groupCard)));
}

function stateLabel(word) {
	const state = wordState(word);
	if (state === "learning") return "Learning · " + streakOf(word) + " of " + LEARNED_AFTER;
	return { new: "New", learned: "Learned", archived: "Archive" }[state];
}

function groupCard(group) {
	const cells = groupWords(group).flatMap((word, i) => [
		i ? h("span", { class: "vs" }, "vs") : null,
		h("div", { class: "group-word" },
			btn(word.es, () => openWord(word), "group-word-name"),
			meaningEl(word, "p", "meaning"),
			h("div", { class: "group-word-foot" },
				h("span", { class: "chip" }, stateLabel(word)),
				btn("Remove", () => removeGroupWord(group, word), "link-btn bad")))
	]);
	return h("article", { class: "group-card" + (group.id === flashId ? " flash" : ""), "data-id": group.id },
		h("div", { class: "group-row" }, cells),
		groupNoteId === group.id ? groupNoteEditor(group) : group.note ? h("p", { class: "group-note" }, group.note) : null,
		groupAddId === group.id ? wordBox("Type a word", "group-add-" + group.id, "Add", value => addTypedToGroup(group, value), cancelGroupAdd) : null,
		h("div", { class: "actions" },
			btn("+ word", () => startGroupAdd(group), "btn"),
			btn(group.note ? "Edit note" : "Add note", () => startGroupNote(group), "btn"),
			btn("Delete group", () => deleteGroup(group), "btn bad")));
}

function groupNoteEditor(group) {
	const save = () => saveGroupNote(group, input.value);
	const input = h("input", {
		class: "inset-input", value: group.note || "", placeholder: "What trips you up", "data-focus": "group-note-" + group.id,
		onkeydown: e => {
			if (e.key === "Enter") { e.preventDefault(); save(); }
			if (e.key === "Escape") cancelGroupNote();
		}
	});
	return h("div", { class: "link-box wide" }, input, btn("Save", save, "btn"), btn("Cancel", cancelGroupNote, "btn"));
}

// --- dictionary review -----------------------------------------------------------

function reviewReason(candidate) {
	if (candidate.genderNote) return candidate.genderNote;
	if (candidate.via === "headword") return "which meaning? · " + candidate.pos;
	if (candidate.via === "form") return "a form of " + candidate.headword + " (" + describeForm(candidate.formTags) + ")";
	if (candidate.via === "spelling") return "spelling";
	if (candidate.via === "similar") return "did you mean";
	return candidate.pos;
}

function renderReview() {
	const n = reviewItems.length;
	el.content.append(h("p", { class: "intro" }, n
		? plural(n, "word") + (n === 1 ? " needs" : " need") + " a decision. Pick the right entry, or keep the word as it is."
		: "Nothing to review."));
	for (const item of reviewItems) {
		const word = db.words.find(other => other.id === item.wordId);
		if (!word) continue;
		el.content.append(h("div", { class: "review-item" },
			h("div", { class: "row-main" }, h("span", { class: "row-word" }, word.es), meaningEl(word, "span", "row-meaning")),
			h("div", { class: "choices" },
				item.candidates.map(candidate => btn([
					h("strong", null, "→ " + candidate.display),
					h("small", null, reviewReason(candidate) + (candidate.senses[0] ? " · " + candidate.senses.slice(0, 2).join("; ") : ""))
				], () => acceptReview(item, candidate), "btn choice-btn")),
				btn("Skip — keep " + word.es, () => skipReview(item, word), "btn"))));
	}
}

// --- flashcards ------------------------------------------------------------------

// The "Which one?" card: pick a word, see the answer, then move on. There is no self-grading.
function whichBody(card, sentence) {
	if (!study.flipped) {
		return [
			h("div", { class: "which-choices" }, card.choices.map((choice, i) =>
				btn([h("span", { class: "which-key keys" }, String(i + 1)), choice.es], () => pick(choice), "big-btn"))),
			h("span", { class: "flash-tip keys" }, "Keys: press a number to pick · Esc stops")
		];
	}
	const right = study.picked === card.word;
	const resets = groupWords(card.group).filter(word => word.review).map(word => word.es);
	return h("div", { class: "flash-back" },
		h("div", { class: "flash-answer word" }, card.word.es),
		right ? h("p", { class: "which-right" }, "Right") : h("p", { class: "which-wrong" }, "You picked " + study.picked.es + ": " + (meaningOf(study.picked).text || "no meaning saved")),
		card.group.note ? h("p", { class: "flash-hint" }, card.group.note) : null,
		sentence,
		right ? null : h("p", { class: "which-wrong" }, "Progress resets for: " + resets.join(", ")),
		btn("Next", () => answer(right), "big-btn next"),
		h("span", { class: "flash-tip keys" }, "Keys: space continues · Esc stops"));
}

function renderStudy() {
	const total = study.queue.length;
	const wrap = h("div", { class: "study" },
		h("div", { class: "study-top" },
			btn([icon("back"), "Words"], endStudy, "back-btn"),
			h("div", { class: "bar", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: "width: " + (100 * study.position / total) + "%" })),
			h("span", { class: "study-count" }, Math.min(study.position + 1, total) + " / " + total)));
	el.content.append(wrap);

	if (!study.card) {
		wrap.append(h("section", { class: "done" },
			h("h2", null, "¡Hecho!"),
			h("p", null, study.knew + " right · " + study.missed.size + " to try again · " + study.learned.length + " moved to Learned"
				+ (study.lapsed.length ? " · " + study.lapsed.length + " back to Learning" : "")),
			study.learned.length ? h("p", { class: "note" }, "Moved to Learned: " + study.learned.join(", ")) : null,
			study.lapsed.length ? h("p", { class: "note" }, "Back to Learning: " + study.lapsed.join(", ")) : null,
			btn("Back to words", endStudy, "pill-btn")));
		return;
	}

	const card = study.card;
	const word = card.word;
	const streak = streakOf(word);
	const meta = h("div", { class: "flash-meta" }, posChip(word),
		wordState(word) === "learned" ? h("span", null, "learned") : [dots(streak), h("span", null, streak + " of " + LEARNED_AFTER + " days")]);
	const sentence = card.sentence ? h("p", { class: "flash-sentence" }, sentenceNode(card.sentence, [word], word)) : null;

	let front;
	if (card.type === "meaning") front = [h("div", { class: "flash-front" }, word.es), meta, sentence];
	else if (card.type === "spanish" || card.type === "which") front = [h("div", { class: "flash-front long" }, card.meaning), meta];
	else front = [h("div", { class: "flash-front long" }, card.cloze.before + "____" + card.cloze.after), meta, card.meaning ? h("p", { class: "flash-hint" }, card.meaning) : null];

	let answerEl;
	if (card.type === "meaning") answerEl = h("div", { class: "flash-answer" }, card.meaning || "(no meaning saved)");
	else if (card.type === "spanish") answerEl = h("div", { class: "flash-answer word" }, word.es);
	else answerEl = h("div", { class: "flash-answer word" }, card.cloze.answer + (normKey(card.cloze.answer) !== word.key ? " · " + word.es : ""));

	wrap.append(h("section", { class: "flashcard", "aria-live": "polite" },
		h("span", { class: "flash-ask" }, { meaning: "What does it mean?", spanish: "Say it in Spanish", cloze: "Fill the gap", which: "Which one?" }[card.type]),
		front,
		card.type === "which" ? whichBody(card, sentence)
			: study.flipped
			? h("div", { class: "flash-back" },
				answerEl,
				card.type === "meaning" ? null : sentence,
				h("div", { class: "grade" }, btn("Missed it", () => answer(false), "big-btn missed"), btn("Got it", () => answer(true), "big-btn got")),
				h("span", { class: "flash-tip keys" }, "Keys: 1 missed it · 2 got it · Esc stops"))
			: [btn("Show answer", flip, "big-btn reveal-btn"), h("span", { class: "flash-tip" }, "Say it out loud first — then check.")]));
	if (study.practice) wrap.append(h("p", { class: "flash-tip" }, "Nothing was due, so this is practice. It still counts."));
}
