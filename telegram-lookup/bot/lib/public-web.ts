import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 500_000;
const MAX_TEXT = 8_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12_000;
const USER_AGENT = "telegram-lookup/0.1 (lawful public lookup)";

export type LookupHit = {
  title: string;
  url: string;
  snippet: string;
};

export type SearchResult = {
  query: string;
  summary: string;
  results: LookupHit[];
};

export type PageResult = {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
};

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

type FetchedPage = {
  finalUrl: string;
  contentType: string;
  body: string;
};

export async function searchPublicWeb(query: string): Promise<SearchResult> {
  const q = query.trim();
  if (q.length < 1 || q.length > 200) {
    throw new Error("Query must be 1 to 200 characters.");
  }

  const results: LookupHit[] = [];
  let summary = "";

  try {
    const ddg = new URL("https://api.duckduckgo.com/");
    ddg.searchParams.set("q", q);
    ddg.searchParams.set("format", "json");
    ddg.searchParams.set("no_html", "1");
    ddg.searchParams.set("skip_disambig", "1");
    const page = await fetchPublic(ddg.href);
    const data = JSON.parse(page.body) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
    };
    if (data.AbstractText && data.AbstractURL) {
      summary = data.AbstractText.slice(0, 1_000);
      results.push({
        title: (data.Heading || q).slice(0, 200),
        url: data.AbstractURL,
        snippet: summary,
      });
    }
  } catch {
    // A second public source still runs below.
  }

  try {
    const wiki = new URL("https://en.wikipedia.org/w/api.php");
    wiki.searchParams.set("action", "opensearch");
    wiki.searchParams.set("search", q);
    wiki.searchParams.set("limit", "5");
    wiki.searchParams.set("namespace", "0");
    wiki.searchParams.set("format", "json");
    const page = await fetchPublic(wiki.href);
    const data = JSON.parse(page.body) as [string, string[], string[], string[]];
    const titles = data[1] ?? [];
    const snippets = data[2] ?? [];
    const urls = data[3] ?? [];
    for (let i = 0; i < titles.length; i += 1) {
      const title = titles[i];
      const url = urls[i];
      if (!title || !url) continue;
      results.push({
        title: title.slice(0, 200),
        url,
        snippet: (snippets[i] ?? "").slice(0, 400),
      });
    }
  } catch {
    // Return whatever the first source found.
  }

  return { query: q, summary, results: results.slice(0, 6) };
}

export async function fetchPublicPage(rawUrl: string): Promise<PageResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("That is not a valid URL.");
  }

  const fetched = await fetchPublic(parsed.href);
  const html =
    fetched.contentType.includes("html") || fetched.body.trimStart().startsWith("<");
  const extracted = html
    ? htmlToText(fetched.body)
    : { title: "", text: fetched.body.replace(/\s+/g, " ").trim() };
  const truncated = extracted.text.length > MAX_TEXT;

  return {
    url: parsed.href,
    finalUrl: fetched.finalUrl,
    title: extracted.title.slice(0, 200),
    text: extracted.text.slice(0, MAX_TEXT),
    truncated,
  };
}

async function fetchPublic(start: string): Promise<FetchedPage> {
  let current = parsePublicUrl(start);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resolved = await resolvePublic(current.hostname);
    const response = await requestFirst(current, resolved);
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers.location);
      if (!location) throw new Error("The site redirected without a location.");
      current = parsePublicUrl(new URL(location, current).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The site returned ${response.status}.`);
    }

    const contentType = headerValue(response.headers["content-type"]) ?? "";
    if (!isTextContent(contentType, response.body)) {
      throw new Error("That page is not a public text page.");
    }

    return {
      finalUrl: current.href,
      contentType,
      body: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
    };
  }

  throw new Error("The page redirected too many times.");
}

function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("Links with a username or password are refused.");
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) {
    throw new Error("Only ports 80 and 443 are allowed.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("That host is not a public website.");
  }
  return url;
}

async function resolvePublic(hostname: string): Promise<ResolvedAddress[]> {
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error("That address is not public.");
    return [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("That host did not resolve.");
  }
  if (records.length === 0) throw new Error("That host did not resolve.");

  const addresses: ResolvedAddress[] = [];
  for (const record of records) {
    if (isBlockedIp(record.address)) throw new Error("That host is not public.");
    addresses.push({ address: record.address, family: record.family === 6 ? 6 : 4 });
  }
  return addresses;
}

async function requestFirst(
  url: URL,
  addresses: ResolvedAddress[],
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  let lastError: Error | null = null;
  for (const resolved of addresses) {
    try {
      return await requestPublic(url, resolved);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error("The site could not be reached.");
      if (wrapped.message === "The page is too large." || wrapped.message === "That page is not a public text page.") {
        throw wrapped;
      }
      lastError = wrapped;
    }
  }
  throw lastError ?? new Error("The site could not be reached.");
}

function requestPublic(
  url: URL,
  resolved: ResolvedAddress,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const lib = url.protocol === "https:" ? https : http;
  const path = `${url.pathname}${url.search}`;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path,
        method: "GET",
        headers: {
          host: url.host,
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9",
          "user-agent": USER_AGENT,
        },
        servername: url.hostname,
        lookup: (_hostname, options, callback) => {
          const wantsAll =
            typeof options === "object" &&
            options !== null &&
            "all" in options &&
            Boolean(options.all);
          if (wantsAll) {
            callback(null, [{ address: resolved.address, family: resolved.family }], resolved.family);
            return;
          }
          callback(null, resolved.address, resolved.family);
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }

        const contentType = headerValue(res.headers["content-type"]) ?? "";
        const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        if (type && !isAllowedType(type)) {
          res.resume();
          reject(new Error("That page is not a public text page."));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Error("The page is too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );

    req.on("error", () => reject(new Error("The site could not be reached.")));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("The site took too long."));
    });
    req.end();
  });
}

function isAllowedType(type: string): boolean {
  return (
    type === "text/html" ||
    type === "text/plain" ||
    type === "text/xml" ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/ld+json" ||
    type.startsWith("text/") ||
    type.endsWith("+json")
  );
}

function isTextContent(contentType: string, body: Buffer): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type && !isAllowedType(type)) return false;
  return !body.includes(0);
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  );
}

function isBlockedIp(address: string): boolean {
  const bare = address.toLowerCase().split("%")[0] ?? "";
  if (bare.startsWith("::ffff:")) {
    const mapped = bare.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex?.[1] && hex[2]) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isBlockedIpv4(
        `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
      );
    }
  }
  const kind = isIP(bare);
  if (kind === 4) return isBlockedIpv4(bare);
  if (kind === 6) return isBlockedIpv6(bare);
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  const first = address.split(":")[0] ?? "";
  if (first.length === 0) return false;
  const head = Number.parseInt(first, 16);
  if (!Number.isInteger(head)) return true;
  if (head >= 0xfc00 && head <= 0xfdff) return true;
  if (head >= 0xfe80 && head <= 0xfebf) return true;
  if (head >= 0xff00) return true;
  return false;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  return {
    title: title.replace(/\s+/g, " ").trim(),
    text: text.replace(/\s+/g, " ").trim(),
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
