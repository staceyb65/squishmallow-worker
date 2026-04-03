export default {
  async fetch(request) {
    // Handle CORS preflight (browser sends OPTIONS sometimes)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response(
      JSON.stringify({ summary: "I see a Squishmallow! (Test response from Worker)" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  },
};
