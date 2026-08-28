/** Worker entry point. */

import { handleContact, handleInvoiceInterest, handlePreflight } from "./handle-contact.ts";
import { corsHeaders } from "./cors.ts";
import type { Env } from "./env.ts";
import { VERSION } from "./version.ts";

const CONTACT_PATH = "/v1/contact";
const INVOICE_INTEREST_PATH = "/v1/invoice-interest";

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...extraHeaders,
        },
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const { pathname } = new URL(request.url);
        const origin = request.headers.get("origin");

        if (pathname === CONTACT_PATH || pathname === INVOICE_INTEREST_PATH) {
            if (request.method === "OPTIONS") return handlePreflight(request, env);
            if (request.method === "POST") {
                return pathname === CONTACT_PATH
                    ? handleContact(request, env)
                    : handleInvoiceInterest(request, env);
            }
            return json(
                { success: false, error: "Method not allowed" },
                405,
                { Allow: "POST, OPTIONS", ...corsHeaders(env, origin) },
            );
        }

        if (pathname === "/" && request.method === "GET") {
            return json(
                {
                    name: "Invaritech Contact API",
                    status: "ok",
                    version: VERSION,
                    endpoints: ["POST /v1/contact", "POST /v1/invoice-interest"],
                },
                200,
            );
        }

        return json({ success: false, error: "Not found" }, 404);
    },
};
