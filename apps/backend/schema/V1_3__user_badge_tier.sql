-- ShipShow Score — within-badge tier (bronze/silver/gold). Surfaced as
-- a colored ring around the badge icon on the leaderboard (Members
-- page). Currently only `steady_eddie` tiers; the column generalizes
-- so other personas can be tiered later without another schema change.
--
-- Mirrors apps/backend/drizzle/0002_sleepy_betty_ross.sql with the
-- `--> statement-breakpoint` markers stripped. See
-- apps/backend/schema/README.md for the convention and docs/scoring.md
-- for the design rationale + thresholds.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "bbstat"."user_badge_tier" AS ENUM ('bronze', 'silver', 'gold');

-- ---------------------------------------------------------------------------
-- Alters
-- ---------------------------------------------------------------------------

-- NULL for non-tiered badges (today: every persona except steady_eddie)
-- and for null `badge` itself.
ALTER TABLE "bbstat"."user_score"
  ADD COLUMN "badge_tier" "bbstat"."user_badge_tier";
