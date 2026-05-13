
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
    // Default: POST / (or any other non-/story path) is identify
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
    const extracted = extractJson(textBlock);

    let parsed;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return json(
        {
          error: "Could not parse Claude response as JSON",
          raw: textBlock,
          extracted,
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

    if (!squishName) {
      return json({ error: "Missing squish_name." }, 400);
    }
    if (!["K", "1", "2", "3", "4", "5", "6"].includes(grade)) {
      return json({ error: "grade_level must be K,1,2,3,4,5,6." }, 400);
    }

    const MODEL_ID = "claude-sonnet-4-6";

    // Spring benchmark WCPM (50th percentile) for grades 1–6 (Hasbrouck & Tindal 2017 norms). [1](https://readingxr.com/child-instructional-recommendations/)[2](https://brighterly.com/blog/reading-speed-by-age/)
    const springWCPM50 = {
      "1": 60,
      "2": 100,
      "3": 112,
      "4": 133,
      "5": 146,
      "6": 146,
    };

    // Constraints
    const isK = grade === "K";
    const minWords = isK ? 30 : 0;
    const maxWords = isK ? 60 : springWCPM50[grade] * 5; // ≤ 5 minutes

    const targetWpm = isK ? 40 : springWCPM50[grade]; // K is a reasonable default (no H&T K norm published)

    const prompt = buildStoryPrompt({
      squishName,
      grade,
      theme,
      minWords,
      maxWords,
      seed,
    });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 800,
        temperature: 0.7,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
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
const extracted = extractJson(textBlock);

let parsed;
try {
  parsed = JSON.parse(extracted);
} catch {
  // Retry once with stricter instruction + lower temperature
  const retryPrompt =
    prompt +
    `\n\nYOUR LAST OUTPUT WAS NOT VALID JSON. Fix it now.
Return ONE-LINE JSON ONLY. No line breaks. Use \\n inside story_text if needed.`;

  const retryRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 800,
      temperature: 0.2, // lower = more obedient formatting
      messages: [{ role: "user", content: [{ type: "text", text: retryPrompt }] }],
    }),
  });

  if (!retryRes.ok) {
    const t = await retryRes.text();
    return json({ error: "Claude retry API error", details: t }, 500);
  }

  const retryJson = await retryRes.json();
  const retryText = retryJson.content?.[0]?.text || "";
  const retryExtracted = extractJson(retryText);

  try {
    parsed = JSON.parse(retryExtracted);
  } catch {
    return json(
      { error: "Could not parse story JSON (after retry)", raw: retryText, extracted: retryExtracted },
      500
    );
  }
}


    // Server-side enforce word count
    const storyText = (parsed.story_text || "").trim();
    const title = (parsed.story_title || "Your Story").trim();
    const tip = (parsed.reading_tip || "").trim();

    const wordCount = countWords(storyText);

    // Enforce caps (regenerate flow later; for now, trim if too long)
    let finalText = storyText;
    let finalWordCount = wordCount;

    if (finalWordCount > maxWords) {
      finalText = trimToMaxWords(finalText, maxWords);
      finalWordCount = countWords(finalText);
    }

    if (isK && finalWordCount < minWords) {
      // If too short, just keep it; we’ll improve with regenerate logic later.
      // (Claude usually respects 30–60.)
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

function extractJson(text) {
  if (!text) return "{}";

  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  if ((t.startsWith("\"{") && t.endsWith("}\"")) || (t.startsWith("'{" ) && t.endsWith("}'"))) {
    t = t.slice(1, -1);
    t = t.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }

  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return t.slice(firstBrace, lastBrace + 1);
  }

  return t;
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
