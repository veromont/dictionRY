const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "vocab.json");
const BACKUP_DIR = path.join(ROOT, "data", "backups");
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

function readVocab() {
	if (!fs.existsSync(DATA_FILE)) {
		fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
		fs.writeFileSync(DATA_FILE, "[]", "utf8");
		return [];
	}
	const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("vocab.json is not an array");
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

function writeVocab(list) {
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
			if (!Array.isArray(parsed)) return json(res, 400, { error: "expected an array" });
			writeVocab(parsed);
			return json(res, 200, { ok: true, count: parsed.length });
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
});
