import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  tools: ["read", "grep"],
  local: { sandbox: true },
  hosting: {
    egressDomains: ["api.telegram.org", "api.duckduckgo.com", "en.wikipedia.org"],
    secretNames: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
  },
});
