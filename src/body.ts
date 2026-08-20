/**
 * Body reading with a hard size ceiling.
 *
 * `Content-Length` is a client-supplied hint: it is absent on chunked requests
 * and can be understated. Checking it alone would let an oversized payload
 * through to the form parser, so the body is counted as it streams in and the
 * read is abandoned the moment it exceeds the limit. The header is still worth
 * checking first, as it rejects an honest oversized request without reading it.
 */

export type BodyResult =
    | { ok: true; form: FormData }
    | { ok: false; reason: "too-large" | "invalid" };

export async function readLimitedFormData(
    request: Request,
    maxBytes: number,
): Promise<BodyResult> {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, reason: "too-large" };
    }

    if (!request.body) return { ok: false, reason: "invalid" };

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return { ok: false, reason: "too-large" };
            }
            chunks.push(value);
        }
    } catch {
        return { ok: false, reason: "invalid" };
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    try {
        const contentType = request.headers.get("content-type") ?? "";
        const form = await new Response(body, {
            headers: { "Content-Type": contentType },
        }).formData();
        return { ok: true, form };
    } catch {
        return { ok: false, reason: "invalid" };
    }
}
