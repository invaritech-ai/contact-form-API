import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
    try {
        const data = await request.json();

        // Validate required fields
        if (!data.name || !data.email) {
            return NextResponse.json(
                { success: false, error: "Name and email are required" },
                { status: 400 }
            );
        }

        // Validate webhook secret if provided
        const webhookSecret = process.env.WEBHOOK_SECRET;
        if (webhookSecret && data.webhookSecret !== webhookSecret) {
            return NextResponse.json(
                { success: false, error: "Invalid webhook secret" },
                { status: 401 }
            );
        }

        // Sanitize data for Google Sheets
        const sanitizedData = { ...data };

        // Convert phone number to string and prefix with single quote to prevent formula interpretation
        if (sanitizedData.phone) {
            // Convert to string and prefix with ' to force Google Sheets to treat as text
            sanitizedData.phone = `'${String(sanitizedData.phone)}`;
        }

        // Call Google Apps Script
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (!googleScriptUrl) {
            return NextResponse.json(
                { success: false, error: "Google Script URL not configured" },
                { status: 500 }
            );
        }

        const response = await fetch(googleScriptUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                ...sanitizedData,
                timestamp: new Date().toISOString(),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Google Script error:", errorText);
            return NextResponse.json(
                { success: false, error: "Failed to save to Google Sheets" },
                { status: 500 }
            );
        }

        const result = await response.json();

        if (!result.success) {
            return NextResponse.json(
                {
                    success: false,
                    error: result.error || "Failed to save data",
                },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: "Form submitted successfully",
        });
    } catch (error) {
        console.error("API error:", error);
        return NextResponse.json(
            { success: false, error: "Internal server error" },
            { status: 500 }
        );
    }
}

// Handle preflight requests
export async function OPTIONS(request: NextRequest) {
    return new NextResponse(null, {
        status: 200,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}
