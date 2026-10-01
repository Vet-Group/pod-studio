CREATE TABLE "shopify_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_connections" ADD CONSTRAINT "shopify_connections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_connections_store_id_unique" ON "shopify_connections" USING btree ("store_id");