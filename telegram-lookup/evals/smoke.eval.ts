import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "A public page URL is fetched with fetch_page.",
  async test(t) {
    await t.send("Fetch https://example.com and tell me the page title.");
    t.succeeded();
    t.calledTool("fetch_page");
  },
});
