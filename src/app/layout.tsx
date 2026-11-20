import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "海量接口搬运备份站 · 聚合去重版",
  description: "TVBox 点播接口与直播源自动备份、整理去重，并输出点播聚合接口与直播聚合接口。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
