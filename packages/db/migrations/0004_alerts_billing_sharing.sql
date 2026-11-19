ALTER TYPE "public"."approval_status" ADD VALUE 'disabled';--> statement-breakpoint
CREATE TABLE "alert_states" (
	"rule_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"state" text DEFAULT 'inactive' NOT NULL,
	"since" timestamp with time zone,
	"value" double precision,
	"evaluated_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"notification" jsonb,
	"incident_id" uuid
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "collector_states" (
	"collector_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "dashboard_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "dashboard_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "starter_dashboards" (
	"workspace_id" uuid NOT NULL,
	"service" text NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_dashboards_workspace_id_service_pk" PRIMARY KEY("workspace_id","service")
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "query" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "comparison" jsonb;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "display_unit" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_subscription_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_status" text DEFAULT 'trialing' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_states" ADD CONSTRAINT "alert_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_states" ADD CONSTRAINT "collector_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_dashboards" ADD CONSTRAINT "starter_dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_states_workspace_idx" ON "alert_states" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "api_tokens_workspace_idx" ON "api_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboard_shares_workspace_idx" ON "dashboard_shares" USING btree ("workspace_id","dashboard_id");