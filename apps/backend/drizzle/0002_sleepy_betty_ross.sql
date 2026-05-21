CREATE TYPE "bbstat"."user_badge_tier" AS ENUM('bronze', 'silver', 'gold');--> statement-breakpoint
ALTER TABLE "bbstat"."user_score" ADD COLUMN "badge_tier" "bbstat"."user_badge_tier";