import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["undici"],
  async rewrites() {
    return [
      { source: "/vod.json", destination: "/api/vod" },
      { source: "/live.json", destination: "/api/live" },
    ];
  },
};

export default nextConfig;
