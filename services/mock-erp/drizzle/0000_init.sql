CREATE TABLE "batches" (
	"batch_id" text PRIMARY KEY NOT NULL,
	"material_id" text NOT NULL,
	"plant_id" text NOT NULL,
	"produced_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_documents" (
	"billing_document_id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"carrier_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"remarks" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY NOT NULL,
	"next_value" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_release_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"sales_order_id" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credit_limit" numeric(14, 2) NOT NULL,
	"credit_exposure" numeric(14, 2) NOT NULL,
	"credit_status" text NOT NULL,
	"currency" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_events" (
	"event_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_events_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"event_type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"by" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_locks" (
	"lock_id" text PRIMARY KEY NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"locked_by" text NOT NULL,
	"locked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_movements" (
	"goods_movement_id" text PRIMARY KEY NOT NULL,
	"movement_type" text NOT NULL,
	"delivery_id" text NOT NULL,
	"plant_id" text NOT NULL,
	"reverses_goods_movement_id" text,
	"posting_date" date NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"posted_by" text NOT NULL,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"material_id" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"packaging" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"sales_order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"plant_id" text NOT NULL,
	"shipment_id" text,
	"status" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"pgi_posted_at" timestamp with time zone,
	"billed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plants" (
	"plant_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"weigh_tolerance_pct" numeric(5, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_periods" (
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "posting_periods_year_month_pk" PRIMARY KEY("year","month")
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"sales_order_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"plant_id" text NOT NULL,
	"status" text NOT NULL,
	"order_value" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"requested_date" date NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"shipment_id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"truck_id" text,
	"status" text NOT NULL,
	"tare_t" numeric(12, 3),
	"gross_t" numeric(12, 3),
	"net_t" numeric(12, 3),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stocks" (
	"plant_id" text NOT NULL,
	"sloc_id" text NOT NULL,
	"material_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"unrestricted_t" numeric(12, 3) NOT NULL,
	"blocked_t" numeric(12, 3) DEFAULT 0 NOT NULL,
	CONSTRAINT "stocks_plant_id_sloc_id_material_id_batch_id_pk" PRIMARY KEY("plant_id","sloc_id","material_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "storage_locations" (
	"plant_id" text NOT NULL,
	"sloc_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "storage_locations_plant_id_sloc_id_pk" PRIMARY KEY("plant_id","sloc_id")
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"truck_id" text PRIMARY KEY NOT NULL,
	"carrier_id" text NOT NULL,
	"registration_no" text NOT NULL,
	"capacity_t" numeric(12, 3) NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weighment_events" (
	"weighment_id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"kind" text NOT NULL,
	"weight_t" numeric(12, 3) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
