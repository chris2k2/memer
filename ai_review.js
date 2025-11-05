// .github/scripts/ai_review.js
// Schreibt NUR den Text (Markdown) in die GitHub Summary – keine Roh-JSONs.
const { execSync } = require("node:child_process");
const https = require("https");
const fs = require("fs");

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error("Fehlt: OPENAI_API_KEY"); process.exit(1); }

function sh(cmd) {
    try { return execSync(cmd, { encoding: "utf8" }).trim(); }
    catch { return ""; }
}
function existsCommit(ref) {
    if (!ref) return false;
    try { execSync(`git cat-file -e ${ref}^{commit}`); return true; }
    catch { return false; }
}

// ---- Diff ermitteln (robust) ----
const argBase = process.argv[2];
const argHead = process.argv[3];
const HEAD = argHead || sh("git rev-parse HEAD");
let BASE = argBase;
const GH_BEFORE = process.env.GITHUB_EVENT_BEFORE || process.env.BEFORE || "";
const isZero = GH_BEFORE && GH_BEFORE.replace(/0/g, "") === "";
if (!BASE && GH_BEFORE && !isZero && existsCommit(GH_BEFORE)) BASE = GH_BEFORE;
if (!BASE || !existsCommit(BASE)) {
    const prev = sh("git rev-parse HEAD^");
    if (existsCommit(prev)) BASE = prev;
}
let diffCmd;
if (!BASE) {
    const EMPTY_TREE = sh("git hash-object -t tree /dev/null");
    diffCmd = `git diff ${EMPTY_TREE} ${HEAD}`;
} else {
    diffCmd = `git diff ${BASE} ${HEAD}`;
}
let diff = sh(diffCmd);
if (!diff) {
    console.error(`Kein Diff ermittelbar. Versucht: ${diffCmd}\nTipp: checkout mit fetch-depth: 0.`);
    process.exit(2);
}
const MAX = 120000;
if (diff.length > MAX) diff = diff.slice(0, MAX) + "\n\n...[TRUNCATED]...";

// ---- Prompt gemäß Vorgabe ----
const systemPrompt = `
Du bist Senior Software Engineer mit Fokus Java.
Liefere eine Analyse zum Commit-Diff gemäß den Punkten:
1) Gib 3 allgemeine Verbesserungsvorschläge.
2) Prüfe, ob Sicherheitsprobleme gemäß OWASP Top Ten vorliegen (kurz begründen).
3) Bewerte den Commit auf einer Skala von 1-10 (knappe Begründung).
4) Prüfe, ob du etwas am Code anhand Java-Best-Practices aktiv vorschlagen/ausführen würdest (konkrete, ausführbare Schritte/Refactorings).
WICHTIG:
- Antworte AUSSCHLIESSLICH als Markdown.
- Erzeuge EINE kompakte, gut lesbare Tabelle mit Spalten: "Codestelle", "Aspekt", "Ergebnis".
- Nutze Stichpunkte in der rechten Spalte, präzise & kurz.

Bewerte den Commit anschließend als Meme, nutze dafür folgenden Service: https://api.memegen.link/images/$templateName/$top/$bottom.png. 
Überlege dir ein passendes Template. In Klammern sind Erklärungen:
  "drake","distracted-boyfriend","success","doge","gru","mordor","change-my-mind"
  und passenden top und bottom Text. Denke an korrekte URL Encodierung. Poste das Bild zu dem Meme mit einer humoristischen Bemerkung direkt drunter. 
  Sei kreativ und roaste den Comitter ruhig, wenn angebracht. Prüfe, dass du das Meme korrekt verwendest.
  Binde das Bild als Markdown Bild im Format "![Image](external URL)" ein, damit ich es im Markdown direkt angezigt bekomme.

`.trim();

// ---- OpenAI Responses API Call ----
const reqBody = JSON.stringify({
    model: "gpt-5",
    input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: diff }
    ]
});

function extractMarkdownText(parsed) {
    // 1) Bevorzugt: output_text
    if (parsed && typeof parsed.output_text === "string" && parsed.output_text.trim()) {
        return parsed.output_text;
    }
    // 2) Fallback: Alles textartige aus output[].content[] zusammenführen
    try {
        const pieces = [];
        const out = parsed?.output || [];
        for (const item of out) {
            const content = item?.content || [];
            for (const c of content) {
                if (typeof c?.text === "string" && c.text.trim()) pieces.push(c.text);
                if (typeof c?.content === "string" && c.content.trim()) pieces.push(c.content);
            }
        }
        const joined = pieces.join("\n").trim();
        if (joined) return joined;
    } catch { /* ignore */ }
    // 3) Manche Implementationen liefern choices/message (extremer Fallback)
    try {
        const msg = parsed?.choices?.[0]?.message?.content;
        if (typeof msg === "string" && msg.trim()) return msg;
    } catch { /* ignore */ }
    return "";
}

function callOpenAI(body) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "api.openai.com",
                path: "/v1/responses",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${API_KEY}`,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (d) => (data += d));
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(data);
                        const md = extractMarkdownText(parsed);
                        if (!md) {
                            // Nur Fehlermeldung ausgeben – KEIN JSON in die Summary kippen
                            console.error("Konnte keinen reinen Text aus der API-Antwort extrahieren.");
                            console.error("HTTP-Status:", res.statusCode);
                            console.error("Kurzinfo:", parsed?.error?.message ?? "Keine Fehlermeldung im Body.");
                            return reject(new Error("NoTextExtracted"));
                        }
                        resolve(md);
                    } catch (e) {
                        // JSON kaputt – Text-Rohantwort NICHT in Summary, nur debug
                        console.error("Antwort war kein JSON. Rohdaten im Log gelassen.");
                        return reject(new Error("InvalidJSON"));
                    }
                });
            }
        );
        req.on("error", (e) => reject(e));
        req.write(body);
        req.end();
    });
}

(async () => {
    try {
        const markdown = await callOpenAI(reqBody);
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath) {
            const header = `# AI Commit Review (GPT-5)\n\n`;
            // Nur Text anhängen – kein JSON, kein Debug
            fs.appendFileSync(summaryPath, header + markdown + "\n");
            console.log("Summary geschrieben →", summaryPath);
        } else {
            console.log(markdown);
        }
    } catch (err) {
        // Keine Summary schreiben, nur sauber fehlschlagen
        console.error("AI-Review fehlgeschlagen:", err.message || err);
        process.exit(1);
    }
})();
