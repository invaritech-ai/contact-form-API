import { google } from "googleapis";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, email, website, workType, headache, message, source } = body;

        // Validate required fields
        if (!name || !email) {
            return NextResponse.json(
                { error: "Name and email are required" },
                { status: 400 }
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
        const values = [
            [timestamp, name, email, website || "", workType || "", headache || "", message || "", source || ""]
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Sheet1!A:H", // Assuming Sheet1 and columns A-H
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
