import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** 点播接口（对应原项目 apilinks.txt 每一行：名称 + 多镜像） */
export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  urls: jsonb("urls").$type<string[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("pending"), // pending | ok | fail | stale
  usedUrl: text("used_url"),
  error: text("error"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  siteCount: integer("site_count").notNull().default(0),
  liveCount: integer("live_count").notNull().default(0),
  parseCount: integer("parse_count").notNull().default(0),
  config: jsonb("config"), // 规范化后（相对路径已补全）的备份配置
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  okAt: timestamp("ok_at", { withTimezone: true }),
});

/** 去重后的点播站点 */
export const vodSites = pgTable("vod_sites", {
  id: serial("id").primaryKey(),
  dedupKey: text("dedup_key").notNull().unique(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  type: integer("type").notNull(),
  api: text("api").notNull(),
  category: text("category").notNull(), // cj | py | js | spider | other
  site: jsonb("site").$type<Record<string, unknown>>().notNull(),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  alive: boolean("alive"),
  latencyMs: integer("latency_ms"),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** 去重后的直播源 */
export const liveSources = pgTable("live_sources", {
  id: serial("id").primaryKey(),
  dedupKey: text("dedup_key").notNull().unique(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  live: jsonb("live").$type<Record<string, unknown>>().notNull(),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  alive: boolean("alive"),
  channelCount: integer("channel_count").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  contentHash: text("content_hash"),
  duplicateOf: text("duplicate_of"),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** 生成产物：合并播放列表、解析/flags 汇总等 */
export const artifacts = pgTable("artifacts", {
  key: text("key").primaryKey(),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("running"), // running | done | error
  trigger: text("trigger").notNull().default("manual"),
  log: text("log").notNull().default(""),
  stats: jsonb("stats").$type<Record<string, number>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
