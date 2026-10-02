-- Replace the tutorial category with finance. Existing tutorials remain opinions; they are not
-- relabelled as financial news. Finance publications are created by their configured source rule.
UPDATE analyses SET category = 'opinion' WHERE category = 'tip';
UPDATE publications SET category = 'opinion', revision = revision + 1, updated_at = now() WHERE category = 'tip';
