CREATE SEQUENCE "public"."generation_dispatch_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"required_provider_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"design_id" text,
	"asset_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"account_id" text,
	"worker_id" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"account_requeues" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_class" text,
	"failure_reason" text,
	"worker_message" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"dispatch_order" bigint DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_requester_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"priority" text NOT NULL,
	"store_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"last_dispatch" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_store_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"priority" text NOT NULL,
	"store_id" text NOT NULL,
	"last_dispatch" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"account_key" text NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"job_types" text[] DEFAULT '{}' NOT NULL,
	"installed_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'available' NOT NULL,
	"cooldown_until" timestamp with time zone,
	"session_expires_at" timestamp with time zone,
	"last_healthy_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_key" text NOT NULL,
	"host" text NOT NULL,
	"version" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requester_turns" ADD CONSTRAINT "generation_requester_turns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requester_turns" ADD CONSTRAINT "generation_requester_turns_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_store_turns" ADD CONSTRAINT "generation_store_turns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_jobs_status_priority_available_at_idx" ON "generation_jobs" USING btree ("status","priority","available_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_claimable_idx" ON "generation_jobs" USING btree ("provider","available_at") WHERE "generation_jobs"."status" = 'queued' and "generation_jobs"."lease_token" is null and "generation_jobs"."cancel_requested" = false;--> statement-breakpoint
CREATE INDEX "generation_jobs_status_lease_expires_at_idx" ON "generation_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_account_id_status_idx" ON "generation_jobs" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_requester_turns_key_idx" ON "generation_requester_turns" USING btree ("priority","store_id","requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_store_turns_key_idx" ON "generation_store_turns" USING btree ("priority","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_worker_id_account_key_unique" ON "provider_accounts" USING btree ("worker_id","account_key");--> statement-breakpoint
CREATE INDEX "provider_accounts_state_idx" ON "provider_accounts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_worker_key_unique" ON "workers" USING btree ("worker_key");