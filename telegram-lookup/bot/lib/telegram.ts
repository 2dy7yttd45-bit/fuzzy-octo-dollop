const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE = 4_000;
const TIMEOUT_MS = 12_000;

export type TelegramSendResult = {
  ok: boolean;
  error?: string;
};

export async function sendTelegramMessage(input: {
  chatId: string;
  text: string;
  replyToMessageId?: number;
}): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set." };

  const chunks = chunkText(input.text.trim() || "I could not write a reply.");
  for (let index = 0; index < chunks.length; index += 1) {
    const text = chunks[index] ?? "";
    let response: Response;
    try {
      response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text,
          reply_to_message_id: index === 0 ? input.replyToMessageId : undefined,
          allow_sending_without_reply: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "Telegram could not be reached." };
    }

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: payload?.description ?? `Telegram returned ${response.status}.` };
    }
  }

  return { ok: true };
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, MAX_MESSAGE));
    rest = rest.slice(MAX_MESSAGE);
  }
  return chunks;
}
