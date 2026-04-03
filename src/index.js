export default {
  async fetch(request) {
    // Enable CORS so your webpage can call this
    return new Response(
      JSON.stringify({
        summary: "I see a Squishmallow! This is a test response.",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
