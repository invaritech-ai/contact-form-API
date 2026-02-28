import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import {
    calculateAssessmentScore,
    formatLabel,
    type AssessmentInputs,
    type AssessmentResult,
} from "@/lib/assessment-calculator";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const OPENROUTER_TIMEOUT_MS = 12_000;
const GOOGLE_SCRIPT_TIMEOUT_MS = 8_000;
const MAX_STRATEGIC_ADVICE_LENGTH = 2_000;
const COMPANY_PLACEHOLDER = "the company";

type AssessmentInsights = Pick<
    AssessmentResult,
    "strategicAdvice" | "reasoning" | "nextSteps"
>;

export async function POST(request: NextRequest) {
    console.log("[assessment] POST received");
    try {
        const data = await request.json().catch(() => null);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            console.log("[assessment] 400: invalid JSON");
            return NextResponse.json(
                { success: false, error: "Invalid JSON payload" },
                { status: 400 }
            );
        }

        const { inputs, leadData, recaptchaToken } = data;
        console.log("[assessment] payload keys:", Object.keys(data));
        console.log("[assessment] inputs present:", !!inputs, "| leadData present:", !!leadData, "| token type:", typeof recaptchaToken, "| token length:", typeof recaptchaToken === "string" ? recaptchaToken.length : 0);

        if (!inputs || typeof inputs !== "object" || !leadData || typeof leadData !== "object") {
            console.log("[assessment] 400: missing inputs or leadData");
            return NextResponse.json(
                { success: false, error: "inputs and leadData are required" },
                { status: 400 }
            );
        }

        // Validate reCAPTCHA (fail-closed to block bot submissions)
        const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY?.trim();
        console.log("[assessment] RECAPTCHA_SECRET_KEY configured:", !!recaptchaSecretKey);
        if (!recaptchaSecretKey) {
            console.log("[assessment] 503: RECAPTCHA_SECRET_KEY not set");
            return NextResponse.json(
                { success: false, error: "reCAPTCHA is not configured" },
                { status: 503 }
            );
        }

        const normalizedRecaptchaToken =
            typeof recaptchaToken === "string" ? recaptchaToken.trim() : "";
        if (!normalizedRecaptchaToken) {
            console.log("[assessment] 400: reCAPTCHA token missing or empty");
            return NextResponse.json(
                { success: false, error: "reCAPTCHA token is required" },
                { status: 400 }
            );
        }

        let captchaStatus: "Verified" | "Not verified" = "Not verified";
        try {
            console.log("[assessment] verifying reCAPTCHA token...");
            const verifyParams = new URLSearchParams({
                secret: recaptchaSecretKey,
                response: normalizedRecaptchaToken,
            });

            const recaptchaResponse = await fetch(
                "https://www.google.com/recaptcha/api/siteverify",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: verifyParams.toString(),
                }
            );

            const recaptchaResult = await recaptchaResponse.json();
            console.log("[assessment] reCAPTCHA result: success=", recaptchaResult.success, "errors=", recaptchaResult["error-codes"]);
            if (!recaptchaResult.success) {
                return NextResponse.json(
                    { success: false, error: "reCAPTCHA verification failed" },
                    { status: 403 }
                );
            }

            captchaStatus = "Verified";
        } catch (error) {
            console.error("[assessment] reCAPTCHA verification error:", error);
            return NextResponse.json(
                { success: false, error: "reCAPTCHA verification unavailable" },
                { status: 503 }
            );
        }

        // Calculate scores server-side
        console.log("[assessment] calculating scores for functionFocus:", (inputs as AssessmentInputs).functionFocus);
        const result = calculateAssessmentScore(inputs as AssessmentInputs);

        // Save lead to Google Sheets (fire-and-forget)
        saveLeadToGoogleSheets(inputs as AssessmentInputs, leadData, result, captchaStatus).catch(
            (err) => console.error("Lead save failed:", err)
        );

        // Attempt AI insight enhancement (best-effort)
        let mergedResult: AssessmentResult = result;
        const openRouterClient = createOpenRouterClient();
        if (openRouterClient) {
            const aiInsights = await generateAIInsights(openRouterClient, inputs as AssessmentInputs, leadData, result);
            if (aiInsights) {
                mergedResult = { ...result, ...aiInsights };
            }
        }

        return NextResponse.json({ success: true, result: mergedResult });
    } catch (error) {
        console.error("Assessment API error:", error);
        return NextResponse.json(
            { success: false, error: "Internal server error" },
            { status: 500 }
        );
    }
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 200,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}

function saveLeadToGoogleSheets(
    inputs: AssessmentInputs,
    leadData: Record<string, unknown>,
    result: AssessmentResult,
    captchaStatus: "Verified" | "Not verified"
): Promise<void> {
    const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
    const googleScriptWebhookSecret = process.env.GOOGLE_SCRIPT_WEBHOOK_SECRET?.trim();

    if (!googleScriptUrl || !googleScriptWebhookSecret) {
        console.error("Google Sheets not configured; skipping lead save");
        return Promise.resolve();
    }

    const assessmentSummary = [
        `Target Function: ${formatLabel(inputs.functionFocus)}`,
        `Primary Goal: ${formatLabel(inputs.primaryWorkflowGoal)}`,
        `Company Size: ${inputs.companySize}`,
        `Volume: ${inputs.monthlyVolumeBand}`,
        `AHT: ${inputs.currentAHTBand}`,
        `Data Structure: ${inputs.dataStructure}`,
        `Process Maturity: ${inputs.processMaturity}`,
        `Data Readiness: ${inputs.dataAccessReadiness}`,
        `Tooling: ${(inputs.tooling ?? []).join(", ")}`,
        `---`,
        `Archetype: ${result.archetypeTitle}`,
        `Scores - Viability: ${result.viabilityScore}, Readiness: ${result.readinessScore}, Risk: ${result.riskScore}`,
    ].join("\n");

    // Sanitize lead data — only allow known string fields
    const allowedLeadFields = new Set(["name", "email", "company", "phone"]);
    const sanitizedLead: Record<string, string> = {};
    for (const [key, val] of Object.entries(leadData)) {
        if (allowedLeadFields.has(key) && typeof val === "string") {
            sanitizedLead[key] = val.slice(0, 500);
        }
    }

    const payload = {
        ...sanitizedLead,
        message: assessmentSummary,
        captcha: captchaStatus,
        webhookSecret: googleScriptWebhookSecret,
        timestamp: new Date().toISOString(),
        archetype: result.archetype,
        archetypeTitle: result.archetypeTitle,
        viability: result.viabilityScore,
        readiness: result.readinessScore,
        risk: result.riskScore,
        companySize: inputs.companySize,
        function: inputs.functionFocus,
        workflowGoal: inputs.primaryWorkflowGoal,
        volume: inputs.monthlyVolumeBand,
    };

    return fetch(googleScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GOOGLE_SCRIPT_TIMEOUT_MS),
    }).then(async (response) => {
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error("Assessment lead save non-OK response:", {
                status: response.status,
                body: body.slice(0, 200),
            });
        }
    });
}

function createOpenRouterClient(): OpenAI | null {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const defaultHeaders: Record<string, string> = {};
    if (process.env.OPENROUTER_REFERER) {
        defaultHeaders["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
    }
    if (process.env.OPENROUTER_APP_NAME) {
        defaultHeaders["X-Title"] = process.env.OPENROUTER_APP_NAME;
    }

    return new OpenAI({
        apiKey,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders,
        timeout: OPENROUTER_TIMEOUT_MS,
    });
}

function sanitizeCompanyName(raw: unknown): string {
    if (typeof raw !== "string") return COMPANY_PLACEHOLDER;
    const name = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64).trim();
    if (!name) return COMPANY_PLACEHOLDER;
    // Basic prompt injection guard
    if (/^(ignore|return|stop|forget|system|assistant|developer|instruction|prompt)\b/i.test(name)) {
        return COMPANY_PLACEHOLDER;
    }
    return name;
}

async function generateAIInsights(
    openai: OpenAI,
    inputs: AssessmentInputs,
    leadData: Record<string, unknown>,
    result: AssessmentResult
): Promise<AssessmentInsights | null> {
    try {
        const company = sanitizeCompanyName(leadData.company);
        const tooling = (inputs.tooling ?? []).length > 0
            ? inputs.tooling.map((item) => formatLabel(item)).join(", ")
            : "None listed";

        const prompt = `Company: ${company}
Size: ${inputs.companySize}
Function: ${formatLabel(inputs.functionFocus)}
Goal: ${formatLabel(inputs.primaryWorkflowGoal)}
Volume: ${inputs.monthlyVolumeBand}
AHT: ${inputs.currentAHTBand}
Process maturity: ${formatLabel(inputs.processMaturity)}
Data structure: ${formatLabel(inputs.dataStructure)}
Data access readiness: ${formatLabel(inputs.dataAccessReadiness)}
Tooling: ${tooling}

Scores:
- Viability: ${result.viabilityScore}/100
- Readiness: ${result.readinessScore}/100
- Risk: ${result.riskScore}/100
- Archetype: ${result.archetypeTitle}`;

        const completion = await openai.chat.completions.create({
            model: OPENROUTER_MODEL,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "You are a senior AI automation consultant. Return strict JSON only with keys strategicAdvice, reasoning, nextSteps.",
                },
                {
                    role: "user",
                    content: [
                        "Use the profile below and produce:",
                        "1) strategicAdvice: one paragraph with 3-4 sentences, specific and direct.",
                        "2) reasoning: array of 3-5 concise bullets.",
                        "3) nextSteps: array of 3-5 actionable bullets.",
                        "",
                        prompt,
                    ].join("\n"),
                },
            ],
        });

        const rawContent = completion.choices[0]?.message?.content;
        if (!rawContent) return null;

        const parsed = JSON.parse(rawContent) as Partial<AssessmentInsights>;
        if (
            typeof parsed.strategicAdvice !== "string" ||
            !Array.isArray(parsed.reasoning) ||
            !Array.isArray(parsed.nextSteps)
        ) {
            return null;
        }

        const reasoning = parsed.reasoning
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 5);

        const nextSteps = parsed.nextSteps
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 5);

        const strategicAdvice = parsed.strategicAdvice.trim().slice(0, MAX_STRATEGIC_ADVICE_LENGTH);

        if (!strategicAdvice || reasoning.length === 0 || nextSteps.length === 0) return null;

        return { strategicAdvice, reasoning, nextSteps };
    } catch (error) {
        console.error("AI insight generation failed:", error);
        return null;
    }
}
