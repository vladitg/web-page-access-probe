import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, firefox, webkit } from "playwright-core";

const homepage = new URL(process.env.HOME_URL);
const feed = new URL(process.env.FEED_URL);
const rounds = Number(process.env.ROUNDS ?? "2");
const warmSession = process.env.WARM_SESSION_WITH_FEED === "1";
const engine = process.env.PROBE_ENGINE ?? "chromium";
const browserType = { chromium, firefox, webkit }[engine];
if (!browserType) throw new Error("Unsupported browser engine.");
if (![2, 4].includes(rounds)) throw new Error("Unsupported number of rounds.");
if (homepage.protocol !== "https:" || homepage.origin !== feed.origin || homepage.username || homepage.password || homepage.port ||
    feed.username || feed.password || feed.port || !homepage.hostname.includes(".") || /^(?:\d|localhost)/i.test(homepage.hostname)) {
  throw new Error("Only public HTTPS pages on one origin are supported.");
}
const decode = value => value.replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function inspect(body, status, headers) {
  let records = 0, temperatures = 0, expiryFlags = 0;
  for (const match of body.matchAll(/\bdata-vue3\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    try {
      const data = JSON.parse(decode(match[2]));
      if (data?.name !== "ThreadMainListItemNormalizer") continue;
      const thread = data.props?.thread;
      if (!thread) continue;
      records++;
      if (typeof thread.temperature === "number" && Number.isFinite(thread.temperature)) temperatures++;
      if (typeof thread.isExpired === "boolean") expiryFlags++;
    } catch { /* Non-JSON presentation data is not a record. */ }
  }
  const items = (body.match(/<item(?:\s|>)/gi) ?? []).length;
  return { status, mitigated: headers["cf-mitigated"] ?? null, retryAfter: headers["retry-after"] ?? null,
    contentType: headers["content-type"] ?? null, ray: headers["cf-ray"] ?? null,
    characters: body.length, records, temperatures, expiryFlags, items,
    listingReadable: status >= 200 && status < 300 && records > 0 && temperatures === records && expiryFlags === records,
    feedReadable: status >= 200 && status < 300 && items > 0 && /(?:rss\+xml|text\/xml|application\/xml)/i.test(headers["content-type"] ?? ""),
  };
}
async function visit(page, url, waitMs = 0) {
  let latestResponse = null;
  const onResponse = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) latestResponse = response;
  };
  page.on("response", onResponse);
  const started = Date.now();
  try {
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const waitStarted = Date.now();
    if (waitMs) await delay(waitMs);
    const waitedMs = Date.now() - waitStarted;
    const body = latestResponse ? await latestResponse.text() : await page.content();
    return { ...inspect(body, latestResponse?.status() ?? 0, latestResponse?.headers() ?? {}),
      requestedDelayMs: waitMs, waitedMs, elapsedMs: Date.now() - started,
      cookieCount: (await page.context().cookies(url.origin)).length,
    };
  } catch (error) {
    return { status: latestResponse?.status() ?? null, error: error.name, elapsedMs: Date.now() - started,
      requestedDelayMs: waitMs, listingReadable: false, feedReadable: false };
  } finally {
    page.off("response", onResponse);
  }
}

const report = { checkedAt: new Date().toISOString(), runtime: "GitHub-hosted " + process.platform + " VM, normal headed " + engine, engine,
  runId: process.env.GITHUB_RUN_ID ?? null, requestedDelayMs: 10_000, warmSession, plannedRounds: rounds, rounds: [] };
const browser = await browserType.launch({ ...(engine === "chromium" ? { executablePath: process.env.CHROME_BIN } : {}), headless: false });
try {
  report.browserVersion = browser.version();
  const controlContext = await browser.newContext();
  const sequenceContext = await browser.newContext();
  const controlPage = await controlContext.newPage();
  const sequencePage = await sequenceContext.newPage();
  if (warmSession) {
    report.warmup = await visit(sequencePage, feed, 10_000);
    console.log("TIMING_BROWSER_WARMUP " + JSON.stringify(report.warmup));
  }
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await delay(30_000);
    const control = await visit(controlPage, feed);
    await delay(15_000);
    const home = await visit(sequencePage, homepage, 10_000);
    const rss = await visit(sequencePage, feed);
    const row = { round, rssControl: control, sequence: { homepage: home, rss },
      sourceReadable: Boolean(home.listingReadable && rss.feedReadable) };
    report.rounds.push(row);
    console.log("TIMING_BROWSER_ROUND " + JSON.stringify(row));
  }
  report.passed = report.rounds.length === rounds && report.rounds.every(row => row.sourceReadable);
} finally {
  await browser.close();
}
await fs.writeFile("timing-browser.json", JSON.stringify(report, null, 2) + "\n");
console.log("TIMING_BROWSER_REPORT " + JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
