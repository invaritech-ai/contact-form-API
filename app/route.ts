/** Health check. */
export const dynamic = "force-dynamic";

export function GET(): Response {
    return new Response(
        JSON.stringify({
            name: "Invaritech Contact API",
            status: "ok",
            endpoint: "POST /v1/contact",
        }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
}
