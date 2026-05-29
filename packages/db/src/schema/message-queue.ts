import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";
import { users } from "./users.js";
import { wahaSessions } from "./waha-sessions.js";

export const messageQueue = sqliteTable("message_queue", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectionId: text("connection_id")
    .references(() => wahaSessions.id, { onDelete: "set null" }),
  chatId: text("chat_id").notNull(),
  type: text("type", { enum: ["text", "image", "document", "video", "audio"] })
    .notNull()
    .default("text"),
  content: text("content", { mode: "json" }).notNull(), // { text?, url?, caption?, filename?, data? }
  status: text("status", {
    enum: ["pending", "processing", "sent", "failed", "cancelled"],
  }).notNull().default("pending"),
  scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  lastError: text("last_error"),
  // Optional metadata: trigger source, label, etc.
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
