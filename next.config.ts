import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["undici"],
  async rewrites() {
    return [
      { source: "/vod.json", destination: "/api/vod" },
      { source: "/live.json", destination: "/api/live" },
      { source: "/live.m3u", destination: "/api/live/m3u" },
      { source: "/live.txt", destination: "/api/live/txt" },
    ];
  },
};

export default nextConfig;
