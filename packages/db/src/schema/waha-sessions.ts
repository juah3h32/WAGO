import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";
import { users } from "./users.js";
import { wahaWorkers } from "./waha-workers.js";

export const wahaSessions = sqliteTable("waha_sessions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workerId: text("worker_id").references(() => wahaWorkers.id, {
    onDelete: "set null",
  }),
  name: text("name"),
  sessionName: text("session_name").notNull().unique(),
  phoneNumber: text("phone_number"),
  status: text("status", {
    enum: ["pending", "scan_qr", "working", "failed", "stopped"],
  })
    .notNull()
    .default("pending"),
  engine: text("engine", { enum: ["NOWEB", "WEBJS", "GOWS"] })
    .notNull()
    .default("NOWEB"),
  warmupConnectedAt: integer("warmup_connected_at", { mode: "timestamp_ms" }),
  warmupTotalSent: integer("warmup_total_sent").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
