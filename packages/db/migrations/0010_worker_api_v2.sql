CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"checksum" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"artifact_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_cleanup" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_cleanup_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "worker_idempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_results" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text NOT NULL,
	"asset_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"upload_key" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "skill" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "result_ids" text[];--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "result_payload" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "provider_meta" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "token_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_idempotency" ADD CONSTRAINT "worker_idempotency_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_results" ADD CONSTRAINT "worker_results_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_uploads" ADD CONSTRAINT "worker_uploads_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_checksum_unique" ON "skill_versions" USING btree ("skill_id","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_idempotency_scope_unique" ON "worker_idempotency" USING btree ("worker_id","job_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_results_job_asset_unique" ON "worker_results" USING btree ("job_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_uploads_upload_key_unique" ON "worker_uploads" USING btree ("upload_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_token_hash_unique" ON "workers" USING btree ("token_hash");