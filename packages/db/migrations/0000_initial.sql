CREATE TYPE "public"."actor_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'active');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('user_default', 'team_decision', 'incident', 'service_map', 'review_feedback');--> statement-breakpoint
CREATE TYPE "public"."panel_type" AS ENUM('timeseries', 'bar', 'stat');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"duration" text NOT NULL,
	"severity" text NOT NULL,
	"channel" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "alert_rules_version_positive" CHECK ("alert_rules"."version" > 0),
	CONSTRAINT "alert_rules_active_needs_approval" CHECK (("alert_rules"."status" = 'active') = ("alert_rules"."approved_by" is not null and "alert_rules"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "catalog_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"last_seen" timestamp with time zone,
	"request_rate" double precision,
	"p95" double precision,
	"stats_refreshed_at" timestamp with time zone,
	CONSTRAINT "catalog_endpoints_workspace_key" UNIQUE("workspace_id","service","method","route")
);
--> statement-breakpoint
CREATE TABLE "catalog_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service" text NOT NULL,
	"metric_name" text NOT NULL,
	"stored_name" text NOT NULL,
	"type" text NOT NULL,
	"unit" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"last_seen" timestamp with time zone,
	CONSTRAINT "catalog_metrics_workspace_key" UNIQUE("workspace_id","service","metric_name")
);
--> statement-breakpoint
CREATE TABLE "collectors" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval" text NOT NULL,
	"metric_names" text[] NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collectors_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "collectors_version_positive" CHECK ("collectors"."version" > 0),
	CONSTRAINT "collectors_active_needs_approval" CHECK (("collectors"."status" = 'active') = ("collectors"."approved_by" is not null and "collectors"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"panel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"default_range" text NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "dashboards_version_positive" CHECK ("dashboards"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone,
	CONSTRAINT "memory_entries_team_decision_needs_person" CHECK ("memory_entries"."kind" <> 'team_decision' or "memory_entries"."created_by_kind" = 'user')
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"outcome" text NOT NULL,
	"escalated_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" "panel_type" NOT NULL,
	"query" text NOT NULL,
	"unit" text NOT NULL,
	"display_unit" text,
	"range" text,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request" text NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panels_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "panels_version_positive" CHECK ("panels"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"pull_request" integer,
	"report_id" uuid,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_findings_one_origin" CHECK (("review_findings"."pull_request" is null) <> ("review_findings"."report_id" is null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"personal_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_workspace_slack_user_key" UNIQUE("workspace_id","slack_user_id"),
	CONSTRAINT "users_workspace_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" text NOT NULL,
	"ingestion_key_hash" text,
	"monthly_model_budget" numeric(12, 4),
	"metrics_store_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_ingestion_key_hash_unique" UNIQUE("ingestion_key_hash")
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_approved_by_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_endpoints" ADD CONSTRAINT "catalog_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_metrics" ADD CONSTRAINT "catalog_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_approved_by_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_escalated_from_fk" FOREIGN KEY ("escalated_from") REFERENCES "public"."model_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rules_workspace_idx" ON "alert_rules" USING btree ("workspace_id","id","version");--> statement-breakpoint
CREATE INDEX "alert_rules_workspace_status_idx" ON "alert_rules" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "collectors_workspace_idx" ON "collectors" USING btree ("workspace_id","id","version");--> statement-breakpoint
CREATE INDEX "collectors_workspace_status_idx" ON "collectors" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "dashboards_workspace_idx" ON "dashboards" USING btree ("workspace_id","id","version");--> statement-breakpoint
CREATE INDEX "memory_entries_workspace_idx" ON "memory_entries" USING btree ("workspace_id","kind","subject");--> statement-breakpoint
CREATE INDEX "model_calls_workspace_created_idx" ON "model_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_workspace_request_idx" ON "model_calls" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "panels_workspace_idx" ON "panels" USING btree ("workspace_id","id","version");--> statement-breakpoint
CREATE INDEX "review_findings_workspace_idx" ON "review_findings" USING btree ("workspace_id","repository","status");