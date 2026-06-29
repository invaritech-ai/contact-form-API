import { NextResponse } from "next/server";

export async function GET() {
    return NextResponse.json({
        name: "Invaritech Contact API",
        version: "1.0.0",
        status: "active",
        endpoints: {
            contact: {
                path: "/api/contact",
                method: "POST",
                description: "Submit contact form data",
            },
        },
        timestamp: new Date().toISOString(),
    });
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 200,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}
