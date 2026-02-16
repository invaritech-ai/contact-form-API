import { google } from "googleapis";
import { NextResponse } from "next/server";

function sanitizeForSheetCell(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }

    const normalized = value
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .trim();

    if (!normalized) {
        return "";
    }

    // Prefix formula-like values to force Google Sheets to treat them as text.
    return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            name,
            email,
            website,
            workType,
            headache,
            message,
            source,
            recaptchaToken,
        } = body;

        // Validate required fields
        if (!name || !email) {
            return NextResponse.json(
                { error: "Name and email are required" },
                { status: 400 }
            );
        }

        // Validate reCAPTCHA (fail-closed to prevent bot submissions)
        const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY?.trim();
        if (!recaptchaSecretKey) {
            return NextResponse.json(
                { error: "reCAPTCHA is not configured" },
                { status: 503 }
            );
        }

        const normalizedRecaptchaToken =
            typeof recaptchaToken === "string" ? recaptchaToken.trim() : "";
        if (!normalizedRecaptchaToken) {
            return NextResponse.json(
                { error: "reCAPTCHA token is required" },
                { status: 400 }
            );
        }

        let captchaStatus: "Verified" | "Not verified" = "Not verified";
        try {
            const verifyParams = new URLSearchParams({
                secret: recaptchaSecretKey,
                response: normalizedRecaptchaToken,
            });

            const recaptchaResponse = await fetch(
                "https://www.google.com/recaptcha/api/siteverify",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: verifyParams.toString(),
                }
            );

            const recaptchaResult = await recaptchaResponse.json();
            if (!recaptchaResult.success) {
                return NextResponse.json(
                    { error: "reCAPTCHA verification failed" },
                    { status: 403 }
                );
            }

            captchaStatus = "Verified";
        } catch (error) {
            console.error("reCAPTCHA verification error:", error);
            return NextResponse.json(
                { error: "reCAPTCHA verification unavailable" },
                { status: 503 }
            );
        }

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
            },
            scopes: [
                "https://www.googleapis.com/auth/drive",
                "https://www.googleapis.com/auth/drive.file",
                "https://www.googleapis.com/auth/spreadsheets",
            ],
        });

        const sheets = google.sheets({ version: "v4", auth });

        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

        if (!spreadsheetId) {
            console.error("GOOGLE_SHEETS_SPREADSHEET_ID is not defined");
            return NextResponse.json(
                { error: "Server configuration error" },
                { status: 500 }
            );
        }

        // Prepare the row data
        const timestamp = new Date().toISOString();
        const sanitizedName = sanitizeForSheetCell(name);
        const sanitizedEmail = sanitizeForSheetCell(email);
        const sanitizedWebsite = sanitizeForSheetCell(website);
        const sanitizedWorkType = sanitizeForSheetCell(workType);
        const sanitizedHeadache = sanitizeForSheetCell(headache);
        const sanitizedMessage = sanitizeForSheetCell(message);
        const sanitizedSource = sanitizeForSheetCell(source);
        const values = [
            [
                timestamp,
                sanitizedName,
                sanitizedEmail,
                sanitizedWebsite,
                sanitizedWorkType,
                sanitizedHeadache,
                sanitizedMessage,
                sanitizedSource,
                captchaStatus,
            ]
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Sheet1!A:I", // Assuming Sheet1 and columns A-I
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values,
            },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error submitting to Google Sheets:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
