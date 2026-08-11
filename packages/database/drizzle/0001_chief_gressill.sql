CREATE TYPE "public"."catalog_item_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."order_line_item_kind" AS ENUM('CATALOG_ITEM', 'OCCURRENCE');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"square_catalog_object_id" text NOT NULL,
	"square_variation_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "catalog_item_status" DEFAULT 'ACTIVE' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_square_variation_id_unique" UNIQUE("square_variation_id")
);
--> statement-breakpoint
CREATE TABLE "order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "order_line_item_kind" NOT NULL,
	"catalog_item_id" uuid,
	"occurrence_id" uuid,
	"reservation_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"name_snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_line_items_kind_matches_target" CHECK ((("order_line_items"."kind" = 'CATALOG_ITEM' and "order_line_items"."catalog_item_id" is not null and "order_line_items"."occurrence_id" is null) or ("order_line_items"."kind" = 'OCCURRENCE' and "order_line_items"."occurrence_id" is not null and "order_line_items"."catalog_item_id" is null))),
	CONSTRAINT "order_line_items_quantity_positive" CHECK ("order_line_items"."quantity" > 0),
	CONSTRAINT "order_line_items_unit_price_non_negative" CHECK ("order_line_items"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"created_by_customer_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"square_order_id" text,
	"square_checkout_url" text,
	"provider_payment_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_square_order_id_unique" UNIQUE("square_order_id")
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "seat_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_customer_id_customers_id_fk" FOREIGN KEY ("created_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_items_status_idx" ON "catalog_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "order_line_items_order_id_idx" ON "order_line_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_household_id_idx" ON "orders" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "orders_status_expires_at_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "reservations_occurrence_active_idx" ON "reservations" USING btree ("occurrence_id") WHERE status in ('HELD', 'CONFIRMED', 'CHECKED_IN');