export default {
  async fetch(request) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // You can use /analyze, or just accept POSTs on /
    // If you want to require /analyze, uncomment these lines:
    // if (url.pathname !== "/analyze") {
    //   return json({ error: "Not found. Try POST /analyze" }, 404);
    // }

    if (request.method !== "POST") {
      return json({ error: "Use POST to send an image (FormData field name: image)" }, 405);
    }

    // Ensure the request is form data (multipart/form-data)
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json(
        { error: "Expected multipart/form-data. Send the image using FormData with key 'image'." },
        400
      );
    }

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return json({ error: "Could not read form data.", details: String(e) }, 400);
    }

    const file = form.get("image");

    // Validate the file field
    if (!file) {
      return json({ error: "No file found. Make sure you send FormData with key 'image'." }, 400);
    }

    // In Workers, uploaded files are usually File objects
    // We'll verify it behaves like a File
    const isFileLike = typeof file === "object" && "arrayBuffer" in file;

    if (!isFileLike) {
      return json(
        { error: "The 'image' field was not a file. Make sure it's a file upload." },
        400
      );
    }

    // Gather helpful info (safe, doesn’t store image)
    const filename = file.name || "unknown";
    const type = file.type || "unknown";
    const sizeBytes = file.size ?? null;

    // Optional: read the bytes to prove we can access them
    // (This does NOT store them — just checks length)
    const buf = await file.arrayBuffer();
    const byteLength = buf.byteLength;

    return json({
      ok: true,
      message: "✅ Image received!",
      received: {
        filename,
        type,
        sizeBytes,
        byteLength
      },
      next: "Great! Next we’ll call Claude Vision from the Worker and return results to your webpage."
    });
  },
};

// --- Helpers ---
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
