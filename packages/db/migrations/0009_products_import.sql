CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"shopify_product_type_id" text GENERATED ALWAYS AS (CASE WHEN source = 'shopify' THEN ref ELSE NULL END) STORED,
	"attempt_token" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor" text,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"product_type_id" text NOT NULL,
	"title" text NOT NULL,
	"description_html" text DEFAULT '' NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"handle" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sku" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_products" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"store_id" text NOT NULL,
	"shopify_gid" text NOT NULL,
	"handle" text,
	"status" text NOT NULL,
	"checksum" text,
	"last_error" text,
	"last_pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"price_row_id" text,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_minor" integer NOT NULL,
	"compare_at_price_minor" integer,
	"sku" text,
	"excluded_markets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory_qty" integer DEFAULT 100 NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "products_id_store_id_unique" ON "products" USING btree ("id","store_id");--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_store_id_shopify_product_type_id_product_types_store_id_id_fk" FOREIGN KEY ("store_id","shopify_product_type_id") REFERENCES "public"."product_types"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_product_type_id_product_types_store_id_id_fk" FOREIGN KEY ("store_id","product_type_id") REFERENCES "public"."product_types"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_product_id_store_id_products_id_store_id_fk" FOREIGN KEY ("product_id","store_id") REFERENCES "public"."products"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_price_row_id_pricing_rules_id_fk" FOREIGN KEY ("price_row_id") REFERENCES "public"."pricing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_runs_store_id_ref_idx" ON "import_runs" USING btree ("store_id","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_store_active_unique" ON "import_runs" USING btree ("store_id","source") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "products_store_id_idx" ON "products" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "products_product_type_id_idx" ON "products" USING btree ("product_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_products_product_id_store_id_unique" ON "store_products" USING btree ("product_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_products_store_id_shopify_gid_unique" ON "store_products" USING btree ("store_id","shopify_gid");--> statement-breakpoint
CREATE INDEX "variants_product_id_idx" ON "variants" USING btree ("product_id");