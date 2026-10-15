require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves all your html pages + pdfs

const API_KEY = (process.env.GROQ_API_KEY || "").trim();
const hasKey = () => API_KEY && API_KEY !== "PASTE_YOUR_GROQ_KEY_HERE";
const BASE = "https://api.groq.com/openai/v1";
const auth = () => ({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });

// Best-first preference. The first one your key can actually use is picked.
const PREFERRED = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];
// Skip models that are not for normal chat
const NOT_CHAT = /whisper|tts|guard|safeguard|embed|orpheus|playai|prompt-guard|compound/i;

let activeModel = null;
let availableModels = [];

async function pickModel(force = false) {
  if (activeModel && !force) return activeModel;
  const r = await axios.get(`${BASE}/models`, { headers: auth(), timeout: 20000 });
  availableModels = (r.data.data || []).map(m => m.id);
  const chat = availableModels.filter(id => !NOT_CHAT.test(id));
  const wanted = (process.env.GROQ_MODEL || "").trim();

  activeModel =
    (wanted && chat.includes(wanted) && wanted) ||
    PREFERRED.find(id => chat.includes(id)) ||
    chat[0];

  if (!activeModel) throw new Error("Your Groq key has no chat models available.");
  console.log(`Using Groq model: ${activeModel}`);
  return activeModel;
}

async function callGroq(text, retry = true) {
  const model = await pickModel();
  try {
    const r = await axios.post(
      `${BASE}/chat/completions`,
      {
        model,
        messages: [
          { role: "system", content: "You are My Study Space AI Assistant, a friendly tutor for students. Give clear, simple explanations." },
          { role: "user", content: text }
        ]
      },
      { headers: auth(), timeout: 60000 }
    );
    return r.data.choices?.[0]?.message?.content || "No response";
  } catch (e) {
    // model vanished? refresh the list once and try again
    if (retry && /does not exist|decommission|not found|no access/i.test(errText(e))) {
      await pickModel(true);
      return callGroq(text, false);
    }
    throw e;
  }
}

function errText(e) {
  return e.response?.data?.error?.message || e.message;
}

// Open http://localhost:3000/api/health to test everything
app.get("/api/health", async (req, res) => {
  if (!hasKey()) return res.status(500).json({ ok: false, problem: "GROQ_API_KEY missing in .env file" });
  try {
    const aiSaid = await callGroq("Reply with the single word: OK");
    res.json({ ok: true, usingModel: activeModel, aiSaid, allModelsYourKeyCanSee: availableModels });
  } catch (e) {
    res.status(500).json({ ok: false, usingModel: activeModel, problem: errText(e), allModelsYourKeyCanSee: availableModels });
  }
});

app.post("/api/chat", async (req, res) => {
  const message = (req.body.message || "").toString().slice(0, 4000);
  if (!message) return res.status(400).json({ reply: "Empty message" });
  if (!hasKey()) return res.status(500).json({ reply: "Server has no API key. Add it to the .env file and restart." });
  try {
    res.json({ reply: await callGroq(message) });
  } catch (e) {
    console.error("Groq error:", errText(e));
    res.status(500).json({ reply: "AI error: " + errText(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  if (!hasKey()) return console.log("WARNING: no API key found. Edit the .env file.");
  pickModel().catch(e => console.log("Could not list models:", errText(e)));
});
