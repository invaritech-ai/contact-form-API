import { handleContact, handlePreflight } from "@/lib/handle-contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
    return handlePreflight(request);
}

export function POST(request: Request): Promise<Response> {
    return handleContact(request);
}
