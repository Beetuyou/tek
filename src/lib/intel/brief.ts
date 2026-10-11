import { createServerFn } from "@tanstack/react-start";
import { normalizeLink } from "./normalize";
import { postKeyFromUrl } from "./post-key";
import { fetchXPost } from "./providers";

export const narratePost = createServerFn({ method: "POST" })
  .validator((input: { url: string }) => {
    const url = typeof input?.url === "string" ? input.url.trim() : "";
    if (!url || url.length > 500) throw new Error("Enter a post link first.");
    return { url };
  })
  .handler(async ({ data }) => {
    const key = postKeyFromUrl(data.url);
    if (!key) return { ok: false as const, error: "That URL is not one post." };
    const link = normalizeLink(data.url);
    let postText = "";
    if (link.platform === "x" && link.handle && link.postId) {
      try {
        const post = await fetchXPost(link.handle, link.postId);
        postText = post.text;
      } catch {
        postText = "";
      }
    }
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "Narrative check is unavailable right now." };

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 220,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Describe what this social post is about and any memecoin narrative people might associate with it. This is unverified context only. Do not invent contract addresses, tickers, or token names as facts. Do not say a token is linked. End by stating this is not a verified match.",
          },
          {
            role: "user",
            content: JSON.stringify({ url: link.canonical || data.url, postText: postText || null }),
          },
        ],
      }),
    });
    if (!res.ok) return { ok: false as const, error: `Narrative check failed (${res.status}).` };
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false as const, error: "Empty narrative." };
    return { ok: true as const, text };
  });