import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
    // Only enforce on mutating requests — GET /api (health check) stays public
    if (request.method === "GET") {
        return NextResponse.next();
    }

    const secret = request.headers.get("x-internal-secret");
    const expectedSecret = process.env.INTERNAL_SECRET;

    if (!expectedSecret || !secret || secret !== expectedSecret) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.next();
}

export const config = {
    matcher: "/api/:path*",
};
