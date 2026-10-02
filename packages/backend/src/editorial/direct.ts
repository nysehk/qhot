// An explicitly configured subscription can publish its supplied copy to /all without model calls.
// Record a rule judgement and use the same publication layer, visibility and full-text policy.
import { isCategoryKey, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { publishArticle } from "../publication/publish.ts";

export async function publishDirectArticle(articleId: string): Promise<boolean> {
  const handled = await sql.begin(async (tx) => {
    // Match the source-edit lock order: source first, then the article.
    const [source] = await tx`SELECT s.config, s.participation_mode FROM sources s JOIN articles a ON a.source_id = s.id
      WHERE a.id = ${articleId} FOR SHARE OF s`;
    const category = source?.config?.directPublishCategory;
    if (source?.participation_mode !== "editorial" || !isCategoryKey(category)) return false;
    const [article] = await tx`SELECT revision, title, body_text, excerpt FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!article) return false;
    if (category === "finance") {
      await tx`UPDATE articles SET timeline_at = coalesce(published_at, discovered_at) WHERE id = ${articleId}`;
    }
    const title = collapseWhitespace(article.title);
    const summary = collapseWhitespace(article.body_text || article.excerpt || article.title).slice(0, 4000);
    const [previous] = await tx`SELECT id FROM analyses WHERE article_id = ${articleId} AND input_revision = ${article.revision}
      AND origin = 'rule' AND prompt_version = 'direct-source-v1' AND category = ${category} ORDER BY id DESC LIMIT 1`;
    if (!previous) {
      await tx`INSERT INTO analyses (article_id, input_revision, origin, prompt_version, relevance, category, tags, subjects,
        title_zh, summary_zh, score, selected, output)
        VALUES (${articleId}, ${article.revision}, 'rule', 'direct-source-v1', 'pass', ${category}, ${[CATEGORY_LABELS[category]]}, ${[]},
          ${title}, ${summary}, NULL, false, ${tx.json({ publicationMode: "direct", category })})`;
    }
    await tx`UPDATE articles SET processing_state = 'analyzed', processing_error = NULL, processing_attempts = 0,
      processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
    return true;
  });
  if (handled) await publishArticle(articleId);
  return handled;
}
