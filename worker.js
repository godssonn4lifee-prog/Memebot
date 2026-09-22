export default {
  async fetch(request, env, ctx) {
    return new Response("Memebot is running!");
  },

  async scheduled(event, env, ctx) {
    console.log("Memebot scheduled task running");
  }
};
