
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // ---- Debug: list models available to THIS API key ----
    if (request.method === "GET" && url.pathname === "/models") {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: "Missing ANTHROPIC_API_KEY secret." }, 500);
      }
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { "Content-Type": "application/json", ...cors() },
      });
    }

    // ---- Guard: API key must exist ----
    if (!env.ANTHROPIC_API_KEY) {
      return json(
        {
          error: "Claude API key is not configured",
          hint: "Set ANTHROPIC_API_KEY as a Worker secret",
        },
        500
      );
    }

    // ---- Route: STORY (JSON in, JSON out) ----
    if (request.method === "POST" && url.pathname === "/story") {
      return handleStory(request, env);
    }

    // ---- Route: IDENTIFY (multipart/form-data image) ----
    if (request.method !== "POST") {
      return json(
        { error: "Use POST / for identify (multipart) or POST /story for story (JSON)." },
        405
      );
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Expected multipart/form-data for identify." }, 400);
    }

    return handleIdentify(request, env);
  },
};

// ------------------------
// IDENTIFY HANDLER
// ------------------------
async function handleIdentify(request, env) {
  try {
    const form = await request.formData();
    const file = form.get("image");

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ error: "No image uploaded (field name must be 'image')." }, 400);
    }

    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (typeof file.size === "number" && file.size > maxBytes) {
      return json({ error: "Image is too large. Please use an image under ~5MB." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const base64 = bytesToBase64(bytes);

    const MODEL_ID = "claude-sonnet-4-6";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 600,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: file.type || "image/jpeg",
                  data: base64,
                },
              },
              {
                type: "text",
                text: `Return ONLY valid JSON. No markdown, no code fences, no commentary.

If the image is NOT a Squishmallow, return a "best_guess" with name "No Squishmallow Found" and confidence 0.

JSON schema (must match exactly):
{
  "best_guess": {
    "name": string,
    "animal_type": string,
    "confidence": number,
    "description": string
  },
  "top_matches": [
    { "name": string, "animal_type": string, "confidence": number },
    { "name": string, "animal_type": string, "confidence": number },
    { "name": string, "animal_type": string, "confidence": number }
  ]
}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return json({ error: "Claude API error", details: text }, 500);
    }

    const result = await response.json();
    const textBlock = result.content?.[0]?.text || "";

    let parsed;
    try {
      parsed = parseClaudeJson(textBlock);
    } catch (e) {
      return json(
        {
          error: "Could not parse Claude response as JSON",
          raw: textBlock,
          message: e.message,
        },
        500
      );
    }

    return json(parsed);
  } catch (err) {
    return json({ error: "Worker crashed", message: err?.message || String(err) }, 500);
  }
}

// ------------------------
// STORY HANDLER
// ------------------------
async function handleStory(request, env) {
  try {
    const body = await request.json();

    const squishName = (body.squish_name || "").trim();
    const grade = String(body.grade_level || "").trim(); // "K".."6"
    const theme = (body.theme || "adventure").trim();
    const seed = String(body.regenerate_seed || Date.now()).trim();

    if (!squishName) return json({ error: "Missing squish_name." }, 400);
    if (!["K", "1", "2", "3", "4", "5", "6"].includes(grade)) {
      return json({ error: "grade_level must be K,1,2,3,4,5,6." }, 400);
    }

    const MODEL_ID = "claude-sonnet-4-6";

    // Spring benchmark WCPM (50th percentile) for grades 1–6
    const springWCPM50 = { "1": 60, "2": 100, "3": 112, "4": 133, "5": 146, "6": 146 };

    const isK = grade === "K";
    const minWords = isK ? 30 : 0;
    const maxWords = isK ? 60 : springWCPM50[grade] * 5; // ≤ 5 minutes
    const targetWpm = isK ? 40 : springWCPM50[grade];    // K default

    const prompt = buildStoryPrompt({ squishName, grade, theme, minWords, maxWords, seed });

    // ----- FIRST TRY -----
    let parsed = await callClaudeForStoryJSON(env, MODEL_ID, prompt, 0.7);

    // If parse failed, retry once (handled inside helper by throwing)
    if (!parsed) {
      const retryPrompt = prompt + `
IMPORTANT FIX:
- Return ONLY JSON (not inside quotes).
- Do NOT wrap JSON in a string.
- Do NOT use markdown or code fences.
- Keep story_text as a normal string (no real line breaks; use \\n if needed).`;

      parsed = await callClaudeForStoryJSON(env, MODEL_ID, retryPrompt, 0.2);
    }

    // ---- Server-side enforce word count ----
    const storyText = (parsed.story_text || "").trim();
    const title = (parsed.story_title || "Your Story").trim();
    const tip = (parsed.reading_tip || "").trim();

    const wordCount = countWords(storyText);

    let finalText = storyText;
    let finalWordCount = wordCount;

    if (finalWordCount > maxWords) {
      finalText = trimToMaxWords(finalText, maxWords);
      finalWordCount = countWords(finalText);
    }

    const recommendedSeconds = Math.ceil((finalWordCount / targetWpm) * 60);

    return json({
      story_title: title,
      story_text: finalText,
      reading_tip: tip || (isK ? "Point to each word as you read!" : "Try to read smoothly and with expression."),
      word_count: finalWordCount,
      target_wpm: targetWpm,
      recommended_seconds: recommendedSeconds,
    });
  } catch (err) {
    return json({ error: "Worker crashed", message: err?.message || String(err) }, 500);
  }
}

function buildStoryPrompt({ squishName, grade, theme, minWords, maxWords, seed }) {
  const gradeLabel = grade === "K" ? "Pre-reader (Kindergarten)" : `Grade ${grade}`;

  return `Return ONLY valid JSON on a SINGLE LINE.
No markdown. No code fences. No extra text.
Do NOT wrap the JSON in quotes.
IMPORTANT: Do NOT include any real line breaks in the JSON.
If you need a line break in the story, you MUST use the two characters \\n inside the story_text string.

Use this exact JSON schema:
{"story_title": string, "story_text": string, "reading_tip": string}

Requirements:
- The Squishmallow named "${squishName}" MUST be the main character.
- Theme: "${theme}".
- Reading level: ${gradeLabel}.
- Total story length must be between ${minWords} and ${maxWords} words.
- Kid-friendly and positive.
- Make this version different using this seed: ${seed}

Respond ONLY with ONE-LINE JSON matching the schema exactly.`;
}

// ------------------------
// Claude call helper for /story
// ------------------------
async function callClaudeForStoryJSON(env, modelId, prompt, temperature) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 900,
      temperature,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${text}`);
  }

  const result = await response.json();
  const textBlock = result.content?.[0]?.text || "";

  try {
    return parseClaudeJson(textBlock);
  } catch (e) {
    // If this is the first pass, caller may retry with stricter prompt
    // By returning null, we allow the caller to decide whether to retry.
    return null;
  }
}

// ------------------------
// Shared helpers
// ------------------------
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function parseClaudeJson(textBlock) {
  if (!textBlock) throw new Error("Empty response from Claude");

  let t = textBlock.trim();

  // Remove markdown fences if present
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  // Attempt 1: direct JSON
  try {
    return JSON.parse(t);
  } catch {}

  // Attempt 2: JSON wrapped as a quoted string (double-encoded)
  // Example: "{\"story_title\":\"...\",\"story_text\":\"...\"}"
  try {
    const inner = JSON.parse(t);
    if (typeof inner === "string") {
      return JSON.parse(inner);
    }
  } catch {}

  // Attempt 3: slice first {...} block
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(t.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Unable to parse JSON.");
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function trimToMaxWords(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}
