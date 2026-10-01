CREATE TABLE "pricing_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"product_type_id" text NOT NULL,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_minor" integer NOT NULL,
	"excluded_markets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_types" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_types_store_id_id_unique" ON "product_types" USING btree ("store_id","id");--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_store_id_product_type_id_product_types_store_id_id_fk" FOREIGN KEY ("store_id","product_type_id") REFERENCES "public"."product_types"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pricing_rules_product_type_id_sort_order_idx" ON "pricing_rules" USING btree ("product_type_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_types_store_id_name_unique" ON "product_types" USING btree ("store_id",lower("name"));