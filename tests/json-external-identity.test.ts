import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { processArticle } from "@aihot/backend/jobs/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { v1Items } from "@aihot/backend/publication/v1";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { adaptIntervals } from "@aihot/backend/sources/collect";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const published = new Date(Date.now() - 3600_000).toISOString();
const sharedUrl = `https://example.org/flash-news/${tag()}`;
let items: Array<Record<string, unknown>> = [];
const server = await stub(() => ({ items }));
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = false;
after(async () => { await server.close(); await stopBoss(); await closeDb(); });

const mapping = {
  url: server.url, itemsPath: "items", titlePaths: ["title"], urlTemplate: "{raw:url}",
  summaryPaths: ["content_text"], summaryIsBody: true, authorPaths: ["_meta.source"],
  publishedAtPath: "date_published", externalIdPath: "id", identityByExternalId: true,
};
function row(id: unknown, title: string) {
  return { id, title, url: sharedUrl, content_text: `${title}的快讯内容。`, date_published: published, _meta: { source: "示例媒体" } };
}
async function source(identityByExternalId = true) {
  const id = `flash-${tag()}`;
  const cfg = { ...mapping, identityByExternalId, _aihot: { initialBackfillLimit: 100 } };
  assertSupportedConfig("json_list", cfg);
  await sql`INSERT INTO sources (id, name, kind, config, tier, interval_minutes) VALUES (${id}, ${id}, 'json_list', ${sql.json(cfg)}, 'T2', 15)`;
  return id;
}

test("distinct flash IDs sharing a URL survive collection, replay and revision", async () => {
  items = [row(0, "第一条快讯"), row("second", "第二条快讯")];
  const id = await source();
  const first = await collectSource(id);
  assert.equal(first.status, "ok", first.error ?? "");
  assert.equal(first.created, 2);
  const replay = await collectSource(id);
  assert.equal(replay.created, 0);
  assert.equal(replay.revised, 0);
  items[0] = row("0", "第一条快讯的更新");
  const changed = await collectSource(id);
  assert.equal(changed.created, 0);
  assert.equal(changed.revised, 1);
  const stored = await sql`SELECT url, author, body_status, body_text, published_at_claim, revision FROM articles WHERE source_id = ${id} ORDER BY revision DESC`;
  assert.equal(stored.length, 2);
  assert.ok(stored.every(a => a.url === sharedUrl && a.author === "示例媒体" && a.body_status === "ok"));
  assert.equal(stored[0]!.body_text, "第一条快讯的更新的快讯内容。");
  assert.equal(stored[0]!.published_at_claim.toISOString(), published);
  assert.deepEqual(stored.map(a => a.revision), [2, 1]);
  const other = await source();
  assert.equal((await collectSource(other)).created, 2, "external IDs are namespaced to their source");
});

test("URL identity remains the default for other JSON subscriptions", async () => {
  items = [row("first", "第一条快讯"), row("second", "第二条快讯")];
  assert.equal((await collectSource(await source(false))).created, 1);
});

test("finance display deduplicates before pagination and restores withdrawn copies", async () => {
  const marker = `财经去重${tag()}`;
  items = Array.from({ length: 42 }, (_, i) => row(`unique-${i}`, `${marker}第${i}条`));
  items.push({ ...items[0], id: "repeat", content_text: ` ${items[0]!.content_text}　\n` });
  const id = await source();
  await sql`UPDATE sources SET config = config || ${sql.json({ directPublishCategory: "finance" })} WHERE id = ${id}`;
  assert.equal((await collectSource(id)).created, 43);
  const articles = await sql`SELECT id FROM articles WHERE source_id = ${id}`;
  for (const a of articles) await processArticle(a.id);
  await sql`UPDATE publications SET tags = ${sql.array([marker])} WHERE source_id = ${id}`;
  const now = new Date();
  const first = await loadPool({ channel: "all", category: "finance", tag: marker, now });
  const timeline = await loadTimeline({ channel: "all", category: "finance", tag: marker, now, limit: 40 });
  assert.equal(timeline.cards.length, 40, "the finance tab on selected navigation lists unscreened flash copy");
  assert.ok(timeline.cards.every(c => !c.item.selected));
  const second = await loadPool({ channel: "all", category: "finance", tag: marker, page: 2, now });
  assert.equal(first.total, 42);
  assert.equal(first.items.length, 40);
  assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 42);
  for (const tab of ["time", "relevance"] as const) {
    assert.equal((await loadPool({ channel: "all", tag: null, category: "finance", q: marker, tab, now })).total, 42);
  }
  const query = { mode: "all", window: "24h", by: "timeline", category: "finance", q: marker, limit: 40, cursor: null } as const;
  const api = await v1Items(query, now);
  const next = await v1Items({ ...query, cursor: api.page.nextCursor }, now);
  assert.equal(api.items.length, 40);
  assert.equal(next.items.length, 2);
  assert.equal(next.page.hasMore, false);
  const copies = await sql`SELECT article_id FROM publications WHERE source_id = ${id} AND summary LIKE ${`%${marker}第0条%`} ORDER BY timeline_at DESC, article_id DESC`;
  assert.equal(copies.length, 2);
  const visibleIds = [...api.items, ...next.items].map(i => i.id);
  assert.ok(visibleIds.includes(copies[0]!.article_id));
  assert.ok(!visibleIds.includes(copies[1]!.article_id));
  await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${copies[0]!.article_id}, 'withdrawn')`;
  await publishArticle(copies[0]!.article_id);
  const restored = await v1Items({ ...query, limit: 100 }, new Date());
  assert.equal(restored.items.length, 42);
  assert.ok(restored.items.some(i => i.id === copies[1]!.article_id));
  const [raw] = await sql`SELECT count(*) AS n FROM articles WHERE source_id = ${id}`;
  assert.equal(raw!.n, 43, "display suppression preserves collected records");
  await sql`UPDATE publications SET category = 'industry' WHERE source_id = ${id}`;
  assert.equal((await loadPool({ channel: "all", category: "industry", tag: marker, now: new Date() })).total, 42);
});

test("external identity refuses missing IDs and configuration paths", async () => {
  const s = { id: "invalid-flash", config: mapping } as unknown as SourceRow;
  items = [row(null, "无 ID 快讯")];
  await assert.rejects(fetchJsonList(s), /missing a valid external ID/);
  await assert.rejects(fetchJsonList({ ...s, config: { ...mapping, externalIdPath: undefined } }), /requires externalIdPath/);
});

test("flash time correction is opt-in and direct work bypasses the AI queue", async () => {
  items = [{ ...row("clock", "时区修正快讯"), date_published: "2026-10-02T14:47:00.000Z" }];
  const id = await source();
  const cfg = { ...mapping, publishedAtCorrectionMinutes: -480, pollIntervalSeconds: 15, directPublishCategory: "finance" };
  assertSupportedConfig("json_list", cfg);
  const candidates = await fetchJsonList({ id, config: cfg } as unknown as SourceRow);
  assert.equal(candidates[0]!.publishedAt!.toISOString(), "2026-10-02T06:47:00.000Z");
  await sql`UPDATE sources SET config = ${sql.json(cfg)}, interval_minutes = 15 WHERE id = ${id}`;
  await collectSource(id);
  const [article] = await sql`SELECT id FROM articles WHERE source_id = ${id}`;
  await queueProcessing(article!.id);
  const [queued] = await sql`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${article!.id} AND name = 'content.direct'`;
  assert.equal(queued!.name, "content.direct");
  await adaptIntervals();
  const [s] = await sql`SELECT interval_minutes, extract(epoch FROM next_fetch_at - last_ok_at) AS delay FROM sources WHERE id = ${id}`;
  assert.equal(s!.interval_minutes, 1);
  assert.ok(Number(s!.delay) > 0 && Number(s!.delay) <= 15);
  assert.throws(() => assertSupportedConfig("json_list", { ...cfg, pollIntervalSeconds: 0 }));
});

test("finance subscription publishes original copy without models and honors withdrawal", async () => {
  items = [row("market", "央行公布最新金融数据"), row("stocks", "银行股收盘上涨")];
  const id = await source();
  await sql`UPDATE sources SET config = config || ${sql.json({ directPublishCategory: "finance" })} WHERE id = ${id}`;
  assert.equal((await collectSource(id)).created, 2);
  const articles = await sql`SELECT id FROM articles WHERE source_id = ${id} ORDER BY title`;
  for (const article of articles) assert.equal((await processArticle(article.id)).state, "direct-published");
  const published = await sql`SELECT category, eligible, selected, score, title, summary, body_mode FROM publications WHERE source_id = ${id}`;
  assert.equal(published.length, 2);
  assert.ok(published.every(p => p.category === "finance" && p.eligible && !p.selected && p.score === null));
  assert.ok(published.every(p => p.summary === `${p.title}的快讯内容。` && p.body_mode === "summary"));
  const articleId = articles[0]!.id;
  await processArticle(articleId);
  const [judgements] = await sql`SELECT count(*) AS total FROM analyses WHERE article_id = ${articleId}`;
  assert.equal(judgements!.total, 1, "replaying direct processing does not duplicate rule judgements");
  const [modelCalls] = await sql`SELECT count(*) AS total FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
  assert.equal(modelCalls!.total, 0);
  const [grouping] = await sql`SELECT count(*) AS total FROM pgboss.job WHERE name = 'events.group' AND data->>'articleId' = ${articleId}`;
  assert.equal(grouping!.total, 0, "finance does not enqueue model grouping");
  await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${articleId}, 'withdrawn')`;
  await processArticle(articleId);
  const [withdrawn] = await sql`SELECT visibility FROM publications WHERE article_id = ${articleId}`;
  assert.equal(withdrawn!.visibility, "withdrawn");
  await sql`UPDATE sources SET participation_mode = 'isolated' WHERE id = ${id}`;
  await publishArticle(articles[1]!.id);
  const [isolated] = await sql`SELECT visibility FROM publications WHERE article_id = ${articles[1]!.id}`;
  assert.equal(isolated!.visibility, "withdrawn");
  assert.throws(() => assertSupportedConfig("json_list", { ...mapping, directPublishCategory: "invalid" }), /不支持/);
});
