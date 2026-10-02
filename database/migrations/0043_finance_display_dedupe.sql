-- Keep every collected article; only public listing suppresses repeated financial copy.
ALTER TABLE publications ADD COLUMN finance_content_key text GENERATED ALWAYS AS (
  CASE WHEN category = 'finance' THEN
    md5(regexp_replace(coalesce(nullif(summary, ''), title), '[[:space:]　]+', '', 'g'))
  ELSE NULL END
) STORED;

CREATE INDEX publications_finance_content_idx
  ON publications (finance_content_key, timeline_at DESC, article_id DESC)
  WHERE category = 'finance' AND visibility = 'public' AND eligible;
