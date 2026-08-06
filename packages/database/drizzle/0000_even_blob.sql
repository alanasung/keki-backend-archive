CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('PURCHASE', 'REDEMPTION', 'ADJUSTMENT', 'EXPIRY', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL', 'SMS', 'MARKETING');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('SCHEDULED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."offering_status" AS ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."offering_type" AS ENUM('CLASS', 'ROOM', 'OPEN_PLAY');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'REFUNDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."waiver_status" AS ENUM('SIGNED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TABLE "children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"cognito_sub" text NOT NULL,
	"email" "citext",
	"phone" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"role" "role" DEFAULT 'CUSTOMER' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_cognito_sub_unique" UNIQUE("cognito_sub"),
	CONSTRAINT "customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"primary_customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity_override" integer,
	"status" "occurrence_status" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "offering_type" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"default_capacity" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "offering_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offerings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "reservation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"customer_id" uuid,
	"child_id" uuid,
	"waiver_record_id" uuid,
	"checked_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_participants_exactly_one_participant" CHECK ((("reservation_participants"."customer_id" is not null and "reservation_participants"."child_id" is null) or ("reservation_participants"."customer_id" is null and "reservation_participants"."child_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_by_customer_id" uuid NOT NULL,
	"status" "reservation_status" NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_pass_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"play_pass_id" uuid NOT NULL,
	"delta_credits" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"reservation_id" uuid,
	"actor_customer_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"offering_id" uuid,
	"total_credits" integer NOT NULL,
	"remaining_credits" integer NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiver_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"household_id" uuid NOT NULL,
	"customer_id" uuid,
	"child_id" uuid,
	"signed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"document_s3_key" text,
	"status" "waiver_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waiver_records_provider_reference_unique" UNIQUE("provider_reference")
);
--> statement-breakpoint
CREATE TABLE "payment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"reservation_id" uuid,
	"provider" text DEFAULT 'SQUARE' NOT NULL,
	"provider_payment_id" text,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "payment_status" NOT NULL,
	"raw_payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_records_provider_payment_id_unique" UNIQUE("provider_payment_id")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"template_key" text NOT NULL,
	"recipient_customer_id" uuid,
	"recipient_address" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_customer_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" "inet"
);
--> statement-breakpoint
ALTER TABLE "children" ADD CONSTRAINT "children_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_primary_customer_id_customers_id_fk" FOREIGN KEY ("primary_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_waiver_record_id_waiver_records_id_fk" FOREIGN KEY ("waiver_record_id") REFERENCES "public"."waiver_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_customer_id_customers_id_fk" FOREIGN KEY ("created_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_pass_ledger" ADD CONSTRAINT "play_pass_ledger_play_pass_id_play_passes_id_fk" FOREIGN KEY ("play_pass_id") REFERENCES "public"."play_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_pass_ledger" ADD CONSTRAINT "play_pass_ledger_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_pass_ledger" ADD CONSTRAINT "play_pass_ledger_actor_customer_id_customers_id_fk" FOREIGN KEY ("actor_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_passes" ADD CONSTRAINT "play_passes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_passes" ADD CONSTRAINT "play_passes_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_records" ADD CONSTRAINT "waiver_records_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_records" ADD CONSTRAINT "waiver_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_records" ADD CONSTRAINT "waiver_records_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_customer_id_customers_id_fk" FOREIGN KEY ("recipient_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_audit_log" ADD CONSTRAINT "staff_audit_log_actor_customer_id_customers_id_fk" FOREIGN KEY ("actor_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "occurrences_starts_at_idx" ON "occurrences" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "occurrences_offering_id_starts_at_idx" ON "occurrences" USING btree ("offering_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_occurrence_id_status_idx" ON "reservations" USING btree ("occurrence_id","status");--> statement-breakpoint
CREATE INDEX "play_pass_ledger_play_pass_id_occurred_at_idx" ON "play_pass_ledger" USING btree ("play_pass_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_status_available_at_idx" ON "notification_outbox" USING btree ("status","available_at");--> statement-breakpoint
-- play_pass_ledger is append-only (AGENTS.md "Data access"): correct by
-- writing a compensating entry, never by editing a row. Enforced here at
-- the database level, not merely by convention.
CREATE FUNCTION "reject_play_pass_ledger_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'play_pass_ledger is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "play_pass_ledger_append_only"
BEFORE UPDATE OR DELETE ON "play_pass_ledger"
FOR EACH ROW EXECUTE FUNCTION "reject_play_pass_ledger_mutation"();