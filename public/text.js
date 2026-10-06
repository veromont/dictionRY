// Text helpers shared by the data model and the screen. All Spanish knowledge comes from the
// dictionary (server side); nothing here knows any grammar.

const ARTICLES = /^(el|la|los|las|un|una|unos|unas)\s+/;
const WORDS_IN_TEXT = /\p{L}+/gu;

// Identity of a word for search and duplicates: case, accents and a leading article ignored.
function normKey(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD").replace(/[̀-ͯ]/g, "")
		.replace(ARTICLES, "")
		.replace(/\s+/g, " ")
		.trim();
}

// Like normKey, but ñ survives: soñar (to dream) and sonar (to sound) are different verbs, and
// "el sueño" is a form of neither. Used wherever inflected forms are compared. ñ is parked on a
// placeholder character while accents are stripped, because stripping would take its tilde too.
function verbKey(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/ñ/g, "\u0001")
		.normalize("NFD").replace(/[̀-ͯ]/g, "")
		.replace(/\u0001/g, "ñ")
		.replace(ARTICLES, "")
		.replace(/\s+/g, " ")
		.trim();
}
