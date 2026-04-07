export default {
  async fetch(request) {
    // --- CORS ---
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (request.method !== "POST") {
      return json({ error: "Use POST with an image." }, 405);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Expected multipart/form-data." }, 400);
    }

    const form = await request.formData();
    const file = form.get("image");

    if (!file || !file.arrayBuffer) {
      return json({ error: "No image uploaded (field name must be 'image')." }, 400);
    }

    // Read image bytes
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Convert to base64 for Claude
    const base64 = btoa(
      Array.from(bytes, (b) => String.fromCharCode(b)).join("")
    );

    // Claude Vision request
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-vision-20240229",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: file.type || "image/jpeg",
                  data: base64
                }
              },
              {
                type: "text",
                text:
                  `You are a Squishmallow expert.
                   Identify the Squishmallow in the photo.

                   Respond ONLY in valid JSON with this shape:

                   {
                     "best_guess": {
                       "name": string,
                       "animal_type": string,
                       "confidence": number (0–100),
                       "description": string
                     },
                     "top_matches": [
                       { "name": string, "animal_type": string, "confidence": number },
                       { "name": string, "animal_type": string, "confidence": number },
                       { "name": string, "animal_type": string, "confidence": number }
                     ]
                   }

                   If you are unsure, lower the confidence and explain politely.
                   Make it kid‑friendly.`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return json({ error: "Claude API error", details: text }, 500);
    }

    const result = await response.json();
    const textBlock = result.content?.[0]?.text;

    let parsed;
    try {
      parsed = JSON.parse(textBlock);
    } catch {
      return json({
        error: "Could not parse Claude response",
        raw: textBlock
      }, 500);
    }

    return json(parsed);
  }
};

// ---- Helpers ----
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...cors() }
  });
}
