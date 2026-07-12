ALTER TABLE "bbstat"."users" ADD COLUMN "manually_included" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP VIEW "bbstat"."leaderboard_entries";--> statement-breakpoint
CREATE VIEW "bbstat"."leaderboard_entries" AS
SELECT
  'person'::text AS entity_kind,
  ps.person_id AS entity_id,
  COALESCE(p.display_name, primary_user.display_name) AS display_name,
  primary_user.username AS username,
  primary_user.email AS email,
  primary_user.bitbucket_uuid AS bitbucket_uuid,
  ps.computed_at,
  ps.commits_eligible,
  ps.commits_total,
  ps.coverage_pct,
  ps.p95_churn_cap,
  ps.score_trending,
  ps.volume_7d,
  ps.volume_30d,
  ps.volume_90d,
  ps.volume_365d,
  ps.volume_all,
  ps.consistency_90d,
  ps.active_days_90d,
  ps.median_churn_90d,
  ps.p95_churn_90d,
  ps.badge,
  ps.badge_tier,
  ps.is_dormant,
  ps.days_since_first_commit,
  COALESCE(
    (SELECT bool_or(u.is_workspace_member) FROM "bbstat"."users" u WHERE u.person_id = ps.person_id),
    false
  ) AS is_workspace_member,
  COALESCE(
    (SELECT bool_or(u.manually_included) FROM "bbstat"."users" u WHERE u.person_id = ps.person_id),
    false
  ) AS manually_included,
  (SELECT count(*)::int FROM "bbstat"."users" u WHERE u.person_id = ps.person_id) AS attached_user_count
FROM "bbstat"."person_score" ps
JOIN "bbstat"."people" p ON p.id = ps.person_id
LEFT JOIN "bbstat"."users" primary_user
  ON primary_user.person_id = ps.person_id
  AND primary_user.is_primary_for_person = true
UNION ALL
SELECT
  'user'::text AS entity_kind,
  us.user_id AS entity_id,
  u.display_name,
  u.username,
  u.email,
  u.bitbucket_uuid,
  us.computed_at,
  us.commits_eligible,
  us.commits_total,
  us.coverage_pct,
  us.p95_churn_cap,
  us.score_trending,
  us.volume_7d,
  us.volume_30d,
  us.volume_90d,
  us.volume_365d,
  us.volume_all,
  us.consistency_90d,
  us.active_days_90d,
  us.median_churn_90d,
  us.p95_churn_90d,
  us.badge,
  us.badge_tier,
  us.is_dormant,
  us.days_since_first_commit,
  u.is_workspace_member,
  u.manually_included,
  1 AS attached_user_count
FROM "bbstat"."user_score" us
JOIN "bbstat"."users" u ON u.id = us.user_id
WHERE u.person_id IS NULL;
