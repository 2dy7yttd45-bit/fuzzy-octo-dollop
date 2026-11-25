import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { fetchPublicPage, type PageResult } from "../lib/public-web.js";

export default defineTool({
  description:
    "Fetch one public http or https page and return its title and text. Refuses private addresses, credentials in the URL, and non-text files.",
  inputSchema: z.object({
    url: z.string().describe("Public http or https URL."),
  }),
  effect: "read",
  async execute({ url }): Promise<PageResult> {
    return fetchPublicPage(url);
  },
});
