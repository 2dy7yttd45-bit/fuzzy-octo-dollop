import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { searchPublicWeb, type SearchResult } from "../lib/public-web.js";

export default defineTool({
  description:
    "Search public DuckDuckGo and Wikipedia sources. Use this for a question that has no URL. Returns titles, URLs, and short snippets.",
  inputSchema: z.object({
    query: z.string().describe("Public lookup query, 1 to 200 characters."),
  }),
  effect: "read",
  async execute({ query }): Promise<SearchResult> {
    return searchPublicWeb(query);
  },
});
