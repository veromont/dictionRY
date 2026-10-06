const http = require("http");
const fs = require("fs");
const path = require("path");
const { openDictionary } = require("./lib/dictionary");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "vocab.json");
const BACKUP_DIR = path.join(ROOT, "data", "backups");
const V1_COPY = path.join(ROOT, "data", "vocab.v1.json");
const DICTIONARY_FILE = path.join(ROOT, "data", "dictionary.sqlite");

// Built by tools/build-dictionary.js. Without it the app still works, just without the dictionary.
let dictionary = null;
try {
	dictionary = openDictionary(DICTIONARY_FILE);
} catch (err) {
	console.log("dictionary not loaded: " + err.message);
}
const PORT = 8787;
const HOST = process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1";
const KEEP_BACKUPS = 20;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon"
};

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}

const EMPTY = { version: 2, words: [], sentences: [], links: [] };

function isCurrentShape(value) {
	return Boolean(value) && Array.isArray(value.words) && Array.isArray(value.sentences) && Array.isArray(value.links);
}

// The page converts an old-format file itself; the server only has to hand it over as is.
function readVocab() {
	if (!fs.existsSync(DATA_FILE)) {
		fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
		fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY, null, 2), "utf8");
		return EMPTY;
	}
	const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
	if (!raw) return EMPTY;
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) && !isCurrentShape(parsed)) throw new Error("vocab.json is neither the old nor the current format");
	return parsed;
}

function backup() {
	if (!fs.existsSync(DATA_FILE)) return;
	fs.mkdirSync(BACKUP_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `vocab-${stamp}.json`));
	const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("vocab-")).sort().reverse().slice(KEEP_BACKUPS);
	for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// The first time an old-format file is overwritten, keep it for good. The rotating backups
// would push it out within 20 saves.
function keepV1Copy() {
	if (fs.existsSync(V1_COPY) || !fs.existsSync(DATA_FILE)) return;
	try {
		if (Array.isArray(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")))) fs.copyFileSync(DATA_FILE, V1_COPY);
	} catch (_) {}
}

function writeVocab(list) {
	keepV1Copy();
	backup();
	const tmp = DATA_FILE + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
	fs.renameSync(tmp, DATA_FILE);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", c => {
			size += c.length;
			if (size > 32 * 1024 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function translate(word) {
	const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=es|en`;
	const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
	if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
	const body = await res.json();
	const text = (body && body.responseData && body.responseData.translatedText || "").trim();
	// MyMemory answers 200 with its quota warning placed in the translation field.
	if (!text || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(text)) {
		throw new Error(text || "empty translation");
	}
	return text;
}

function serveStatic(res, urlPath) {
	const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
	const file = path.join(PUBLIC_DIR, rel);
	if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
		return;
	}
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
		"Cache-Control": "no-cache"
	});
	fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
	try {
		if (url.pathname === "/api/vocab" && req.method === "GET") {
			return json(res, 200, readVocab());
		}
		if (url.pathname === "/api/vocab" && req.method === "PUT") {
			const parsed = JSON.parse(await readBody(req));
			// An old-format save can only come from a tab still running the previous version of the
			// page; accepting it would overwrite the converted file with the old shape.
			if (!isCurrentShape(parsed)) return json(res, 400, { error: "expected { words, sentences, links } — reload the page" });
			writeVocab(parsed);
			return json(res, 200, { ok: true, count: parsed.length });
		}
		if (url.pathname === "/api/dict" && req.method === "GET") {
			if (!dictionary) return json(res, 503, { error: "dictionary not built — run: node tools/build-dictionary.js <dump>" });
			return json(res, 200, dictionary.lookup(url.searchParams.get("q") || ""));
		}
		if (url.pathname === "/api/translate" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" });
			try {
				return json(res, 200, { text: await translate(q) });
			} catch (err) {
				return json(res, 502, { error: String(err.message || err) });
			}
		}
		if (req.method === "GET") return serveStatic(res, url.pathname);
		json(res, 405, { error: "method not allowed" });
	} catch (err) {
		json(res, 500, { error: String(err.message || err) });
	}
});

server.on("error", err => {
	// Already running (startup shortcut fired twice, or a manual run): leave the live one alone.
	if (err.code === "EADDRINUSE") {
		console.log(`port ${PORT} already in use — another instance is serving, exiting.`);
		process.exit(0);
	}
	throw err;
});

server.listen(PORT, HOST, () => {
	console.log(`spanish-vocab on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (data: ${DATA_FILE})`);
	console.log(dictionary ? `dictionary: ${dictionary.meta.entries} headwords, built ${dictionary.meta.built}` : "dictionary: not built");
});
