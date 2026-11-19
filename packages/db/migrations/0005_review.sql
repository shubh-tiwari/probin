CREATE TABLE "code_index" (
	"workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"commit" text NOT NULL,
	"index" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_index_workspace_id_repository_commit_pk" PRIMARY KEY("workspace_id","repository","commit")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"finding_id" uuid,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pull_request" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "line" integer;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "external_ref" jsonb;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "review_findings" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "code_index" ADD CONSTRAINT "code_index_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_report_idx" ON "review_comments" USING btree ("workspace_id","report_id");--> statement-breakpoint
CREATE INDEX "review_reports_workspace_idx" ON "review_reports" USING btree ("workspace_id","created_at");