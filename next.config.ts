import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext traces the server externals and emits only the packages required
  // by the self-hosted Relay runtime under dist/standalone.
  output: "standalone",
};

export default nextConfig;
