import {
  defineChannel,
  localDevStrict,
  POST,
  sharedSecretAuth,
} from "@grok/agent-sdk/channels";
import * as z from "zod/v4";
import { sendTelegramMessage } from "../lib/telegram.js";

type TelegramState = {
  chatId: string;
  replyToMessageId: number;
};

async function replyInChat(input: {
  chatId: string;
  text: string;
  replyToMessageId?: number;
}): Promise<void> {
  const result = await sendTelegramMessage(input);
  if (!result.ok && result.error) console.error(result.error);
}

const WELCOME = [
  "أنا بوت بحث عام. أبحث في صفحات علنية مباحة وألخصها مع الرابط.",
  "أرسل سؤالاً أو رابط https.",
  "ما أساعد في أي طلب مخالف للقانون، ولا أجيب محتوى جنسياً أو خاصاً.",
  "",
  "I look up lawful public pages and cite the source.",
  "Send a question or an https link. I will not help with anything illegal.",
].join("\n");

const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      text: z.string().optional(),
      chat: z.object({
        id: z.union([z.number(), z.string()]),
        type: z.string().optional(),
      }),
      from: z
        .object({
          id: z.union([z.number(), z.string()]),
          is_bot: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export default defineChannel<TelegramState>({
  state: { chatId: "", replyToMessageId: 0 },
  auth: [
    localDevStrict(),
    sharedSecretAuth({
      header: "X-Telegram-Bot-Api-Secret-Token",
      secret: "TELEGRAM_WEBHOOK_SECRET",
    }),
  ],
  routes: [
    POST("/webhook", {
      description: "Receive a Telegram update and reply in the same chat.",
      bodySchema: updateSchema,
      handler: async (_request, { send, waitUntil, body }) => {
        const message = body.message;
        if (!message || message.from?.is_bot) {
          return new Response(null, { status: 202 });
        }

        const chatId = String(message.chat.id);
        const text = message.text?.trim() ?? "";
        const state: TelegramState = {
          chatId,
          replyToMessageId: message.message_id,
        };

        if (!text) {
          waitUntil(
            replyInChat({
              chatId,
              replyToMessageId: message.message_id,
              text: "أرسل سؤالاً أو رابط https عام.",
            }),
          );
          return new Response(null, { status: 202 });
        }

        const command = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
        if (command === "/start" || command === "/help") {
          waitUntil(
            replyInChat({
              chatId,
              replyToMessageId: message.message_id,
              text: WELCOME,
            }),
          );
          return new Response(null, { status: 202 });
        }

        waitUntil(
          send(text, {
            continuationToken: `telegram:${chatId}`,
            state,
            title: `Telegram ${chatId}`,
          }),
        );
        return new Response(null, { status: 202 });
      },
    }),
  ],
  events: {
    async "message.completed"(event, channel) {
      if (event.data.finishReason === "tool_call" || event.data.text === "") return;
      if (!channel.state.chatId) return;
      try {
        await replyInChat({
          chatId: channel.state.chatId,
          replyToMessageId: channel.state.replyToMessageId || undefined,
          text: event.data.text,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Telegram reply failed.");
      }
    },
  },
});
