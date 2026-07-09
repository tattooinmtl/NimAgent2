// NimAgent extension: web search + page fetch with NO third-party API service.
// Search uses DuckDuckGo directly (no key, no account); web_fetch reads any
// http(s) page as plain text.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NimAgent/0.1 (+https://localhost)";

async function ddgInstant(query) {
  const url =
    "https://api.duckduckgo.com/?q=" +
    encodeURIComponent(query) +
    "&format=json&no_html=1&skip_disambig=1";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const data = await res.json();
  const out = [];
  if (data.AbstractText) out.push(`${data.Heading || query}: ${data.AbstractText}`);
  for (const t of data.RelatedTopics || []) {
    if (t.Text && t.FirstURL) out.push(`- ${t.Text} (${t.FirstURL})`);
    if (out.length >= 8) break;
  }
  return out.length ? out.join("\n") : null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// DDG lite wraps result URLs in a redirect: //duckduckgo.com/l/?uddg=<real-url>&rut=…
function realUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

async function ddgLite(query, maxResults = 8) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return `search failed: HTTP ${res.status}`;
  const html = await res.text();

  // Links: <a rel="nofollow" href="…" class='result-link'>Title</a>
  // Snippets follow in <td class='result-snippet'>…</td>. Quote style varies.
  const linkRe = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i;

  const results = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const link = realUrl(decodeEntities(m[1]));
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    // Look for the snippet in the chunk between this link and the next one.
    const tail = html.slice(linkRe.lastIndex, linkRe.lastIndex + 2000);
    const sm = tail.match(snippetRe);
    const snippet = sm
      ? decodeEntities(sm[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
      : "";
    if (title && link) {
      results.push(`- ${title}\n  ${link}${snippet ? `\n  ${snippet}` : ""}`);
    }
  }
  return results.length ? results.join("\n") : "(no results)";
}

// ---------------------------------------------------------------------------
// YouTube transcript extraction — native, no API key, no external AI service.
// Reads the watch page's ytInitialPlayerResponse, picks a caption track, and
// fetches it in json3 format. The agent summarizes the transcript itself.
// ---------------------------------------------------------------------------

function extractVideoId(urlOrId) {
  const s = String(urlOrId || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/
  );
  return m ? m[1] : null;
}

function isYoutubeUrl(url) {
  return /(?:^|\/\/)(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(String(url || ""));
}

// YouTube's public web timedtext endpoint returns an EMPTY 200 without a
// proof-of-origin token, so we go through the innertube player API with the
// ANDROID client context instead — its caption URLs work with a plain GET.
// (This uses YouTube's own embedded public endpoint; no user API key.)
const YT_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

async function ytPlayer(videoId) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": YT_UA },
    body: JSON.stringify({
      context: {
        client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" },
      },
      videoId,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`player API HTTP ${res.status}`);
  return res.json();
}

// Caption bodies arrive as json3 events or timedtext XML depending on client.
function parseCaptionBody(body, timestamps) {
  const trimmed = String(body || "").trim();
  const lines = [];
  if (trimmed.startsWith("{")) {
    let cap;
    try { cap = JSON.parse(trimmed); } catch { return lines; }
    for (const ev of cap.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim();
      if (!text) continue;
      lines.push(timestamps ? `[${fmtTime(ev.tStartMs || 0)}] ${text}` : text);
    }
    return lines;
  }
  // <p t="1360" d="1680">text with optional <s> segments</p>
  const re = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(timestamps ? `[${fmtTime(Number(m[1]))}] ${text}` : text);
  }
  return lines;
}

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function youtubeTranscript({ url, lang = "en", timestamps = true, max_chars = 20000 }) {
  const videoId = extractVideoId(url);
  if (!videoId) return "youtube_transcript error: could not find a video id in: " + url;

  const player = await ytPlayer(videoId);
  const playability = player.playabilityStatus || {};
  if (playability.status && playability.status !== "OK") {
    return `youtube_transcript error: video is ${playability.status}${playability.reason ? ` — ${playability.reason}` : ""}`;
  }

  const details = player.videoDetails || {};
  const header = [
    `Title: ${details.title || "(unknown)"}`,
    `Channel: ${details.author || "(unknown)"}`,
    `Length: ${details.lengthSeconds ? fmtTime(details.lengthSeconds * 1000) : "?"}  Views: ${details.viewCount || "?"}`,
    `Video: https://youtu.be/${videoId}`,
  ].join("\n");
  const description = (details.shortDescription || "").trim().slice(0, 1500);

  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    return `${header}\n\n(no captions available for this video — cannot extract a transcript)\n\nDescription:\n${description || "(none)"}`;
  }

  // Prefer an exact language match, then a manual (non auto-generated) track,
  // then whatever exists. Auto-generated tracks have kind === "asr".
  const want = String(lang).toLowerCase();
  const track =
    tracks.find((t) => t.languageCode?.toLowerCase() === want && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode?.toLowerCase().startsWith(want)) ||
    tracks.find((t) => t.kind !== "asr") ||
    tracks[0];

  const capRes = await fetch(track.baseUrl + "&fmt=json3", {
    headers: { "User-Agent": YT_UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!capRes.ok) return `${header}\n\ncaption track fetch failed: HTTP ${capRes.status}`;
  const lines = parseCaptionBody(await capRes.text(), timestamps);
  if (!lines.length) return `${header}\n\n(caption track "${track.languageCode}" was empty)`;

  let transcript = lines.join("\n");
  const capLen = Math.max(2000, Math.min(Number(max_chars) || 20000, 60000));
  if (transcript.length > capLen) transcript = transcript.slice(0, capLen) + "\n…[transcript truncated]";

  const trackNote = `Transcript (${track.languageCode}${track.kind === "asr" ? ", auto-generated" : ""}, ${lines.length} lines):`;
  return [header, "", `Description (first 1500 chars):\n${description || "(none)"}`, "", trackNote, transcript].join("\n");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export default {
  name: "web-search",
  tools: [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web via DuckDuckGo (no API key, no external service account). Returns result titles, URLs, and snippets. Use for current info or docs, then read a result with web_fetch.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "integer", description: "Max results, default 8" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description:
          "Fetch an http(s) URL and return its readable text content (HTML stripped). Use after web_search to read documentation or articles. YouTube URLs are automatically routed to youtube_transcript.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to fetch" },
            max_chars: { type: "integer", description: "Max characters to return, default 15000" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "youtube_transcript",
        description:
          "Get a YouTube video's title, channel, description, and full timestamped transcript from its caption tracks (no API key, no external AI service). Use this to 'watch' a video: read the transcript, then summarize or extract what the user needs.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "YouTube URL (watch/shorts/youtu.be) or bare 11-char video id" },
            lang: { type: "string", description: "Preferred caption language code, default 'en'" },
            timestamps: { type: "boolean", description: "Prefix each line with [mm:ss], default true" },
            max_chars: { type: "integer", description: "Max transcript characters, default 20000" },
          },
          required: ["url"],
        },
      },
    },
  ],
  impl: {
    async web_search({ query, max_results = 8 }) {
      try {
        const lite = await ddgLite(query, max_results);
        if (lite && lite !== "(no results)" && !lite.startsWith("search failed")) return lite;
        const instant = await ddgInstant(query);
        return instant || lite;
      } catch (e) {
        return "web_search error: " + e.message;
      }
    },

    async youtube_transcript(args) {
      try {
        return await youtubeTranscript(args || {});
      } catch (e) {
        return "youtube_transcript error: " + (e.name === "TimeoutError" ? "request timed out (30s)" : e.message);
      }
    },

    async web_fetch({ url, max_chars = 15000 }) {
      try {
        if (!/^https?:\/\//i.test(String(url))) {
          return "web_fetch error: only http(s) URLs are supported";
        }
        // A YouTube page's HTML is useless as text — return the transcript instead.
        if (isYoutubeUrl(url) && extractVideoId(url)) {
          return await youtubeTranscript({ url, max_chars });
        }
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) return `web_fetch failed: HTTP ${res.status} ${res.statusText}`;
        const type = res.headers.get("content-type") || "";
        const body = await res.text();
        const text = /html/i.test(type) ? htmlToText(body) : body;
        const cap = Math.max(500, Math.min(Number(max_chars) || 15000, 60000));
        return text.length > cap ? text.slice(0, cap) + "\n…[truncated]" : text;
      } catch (e) {
        return "web_fetch error: " + (e.name === "TimeoutError" ? "request timed out (30s)" : e.message);
      }
    },
  },
};
