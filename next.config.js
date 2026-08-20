/** @type {import('next').NextConfig} */
const nextConfig = {
    // CORS is handled per-request in the route so that ALLOWED_ORIGINS is
    // honoured. A platform-level wildcard header would override it.
    outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
