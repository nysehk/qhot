-- CrabPI encodes Asia/Shanghai wall time with a Z suffix. Repair this specific source's old rows.
UPDATE articles SET published_at_claim = published_at_claim - interval '8 hours',
  published_at = CASE WHEN published_at_claim - interval '8 hours' <= discovered_at + interval '1 hour'
    THEN published_at_claim - interval '8 hours' ELSE NULL END,
  timeline_at = CASE WHEN published_at_claim - interval '8 hours' <= discovered_at + interval '1 hour'
    THEN published_at_claim - interval '8 hours' ELSE discovered_at END
WHERE source_id = 'json-openrich-flash-news' AND published_at_claim IS NOT NULL;

UPDATE publications p SET published_at = a.published_at, timeline_at = a.timeline_at, sort_at = a.timeline_at,
  updated_at = now(), revision = p.revision + 1
FROM articles a WHERE p.article_id = a.id AND a.source_id = 'json-openrich-flash-news';
