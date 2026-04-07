export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // ---- Debug: list models available to THIS API key ----
    // Visit: https://YOUR-WORKER.workers.dev/models
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

    if (request.method !== "POST") {
      return json({ error: "Use POST with an image (FormData field: image)." }, 405);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Expected multipart/form-data." }, 400);
    }

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

      // ---- Claude request ----
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
                  text:
`Return ONLY valid JSON. No markdown, no code fences, no commentary.

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

      // ---- Robust parsing: extract JSON even if Claude wraps it ----
      const extracted = extractJson(textBlock);

      let parsed;
      try {
        parsed = JSON.parse(extracted);
      } catch (e) {
        return json(
          {
            error: "Could not parse Claude response as JSON",
            hint: "Claude returned non-JSON or wrapped JSON. See raw + extracted.",
            raw: textBlock,
            extracted,
          },
          500
        );
      }

      return json(parsed);
    } catch (err) {
      return json(
        { error: "Worker crashed", message: err?.message || String(err) },
        500
      );
    }
  },
};

// ---- Base64 helper (chunked) ----
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// ---- Extract JSON from Claude text safely ----
function extractJson(text) {
  if (!text) return "{}";

  // Remove common markdown fences
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  // If Claude returned a JSON string like "{\n ... }" with escapes, try unescaping
  // Only do this if it *looks* like it begins with a quoted brace.
  if ((t.startsWith("\"{") && t.endsWith("}\"")) || (t.startsWith("'{" ) && t.endsWith("}'"))) {
    t = t.slice(1, -1);
    t = t.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }

  // If there’s extra text, try to grab the first {...} block
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return t.slice(firstBrace, lastBrace + 1);
  }

  return t;
}

// ---- Helpers ----
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
