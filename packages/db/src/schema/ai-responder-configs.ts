import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";
import { users } from "./users.js";
import { wahaSessions } from "./waha-sessions.js";

export const aiResponderConfigs = sqliteTable("ai_responder_configs", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  connectionId: text("connection_id").notNull().unique()
    .references(() => wahaSessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull()
    .references(() => users.id),
  enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),
  provider: text("provider").default("anthropic").notNull(), // "anthropic" | "openai"
  model: text("model").default("claude-haiku-4-5-20251001").notNull(),
  apiKey: text("api_key"),
  systemPrompt: text("system_prompt"),
  maxTokens: integer("max_tokens").default(500).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
