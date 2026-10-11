/**
 * X (Twitter) Adapter
 * Uses official API v2 when X_BEARER_TOKEN is set.
 * Falls back gracefully if missing.
 */

const X_API = 'https://api.twitter.com/2';

export interface XPost {
  id: string;
  text: string;
  authorHandle?: string;
  authorId?: string;
  createdAt?: string;
  media?: { type: string; url?: string }[];
  conversationId?: string;
}

export async function fetchXPost(tweetId: string): Promise<XPost | null> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.warn('X_BEARER_TOKEN not set — cannot fetch full post');
    return null;
  }

  const url = `${X_API}/tweets/${tweetId}?expansions=author_id,attachments.media_keys&tweet.fields=created_at,conversation_id,text&user.fields=username&media.fields=url,preview_image_url`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    console.error('X API error', res.status);
    return null;
  }

  const data = await res.json();
  const tweet = data.data;
  if (!tweet) return null;

  const user = data.includes?.users?.[0];

  return {
    id: tweet.id,
    text: tweet.text || '',
    authorHandle: user?.username,
    authorId: tweet.author_id,
    createdAt: tweet.created_at,
    conversationId: tweet.conversation_id,
  };
}
