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
        return json(
          { error: "Missing ANTHROPIC_API_KEY secret in Worker settings." },
          500
        );
      }

      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        }
      });

      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // ---- Guard: API key must exist ----
    if (!env.ANTHROPIC_API_KEY) {
      return json(
        {
          error: "Claude API key is not configured",
          hint: "Set ANTHROPIC_API_KEY as a Worker secret"
        },
        500
      );
    }

    // ---- Only allow POST for image analysis ----
    if (request.method !== "POST") {
      return json({ error: "Use POST with an image (FormData field: image)." }, 405);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Expected multipart/form-data." }, 400);
    }

    try {
      // ---- Read uploaded image ----
      const form = await request.formData();
      const file = form.get("image");

      if (!file || typeof file.arrayBuffer !== "function") {
        return json(
          { error: "No image uploaded (field name must be 'image')." },
          400
        );
      }

      // Optional: prevent huge uploads (helps avoid memory issues)
      const maxBytes = 5 * 1024 * 1024; // 5MB
      if (typeof file.size === "number" && file.size > maxBytes) {
        return json(
          { error: `Image is too large. Please use an image under ~5MB.` },
          400
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());

      // ---- Convert image to base64 (chunked, reliable) ----
      const base64 = bytesToBase64(bytes);

      // ---- Choose a model ----
      // Default to a current Sonnet model ID from Anthropic docs.
      // If you get "model not found", open /models and copy an ID from there.
      const MODEL_ID = "claude-sonnet-4-6";

      // ---- Call Claude (Messages API) ----
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
          // NOTE: NO anthropic-beta header here.
          // Beta headers must be valid documented flags; invalid ones are rejected. [1](https://platform.claude.com/docs/en/api/models/list)
        },
        body: JSON.stringify({
          model: MODEL_ID,
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
                  text: `You are a Squishmallow expert.

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
Make it kid-friendly.`
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
        return json(
          { error: "Could not parse Claude response as JSON", raw: textBlock },
          500
        );
      }

      return json(parsed);
    } catch (err) {
      return json(
        {
          error: "Worker crashed",
          message: err?.message || String(err)
        },
        500
      );
    }
  }
};

// ---- Base64 helper (chunked to avoid large-string failures) ----
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000; // 32KB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// ---- Helpers ----
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors()
    }
  });
}
