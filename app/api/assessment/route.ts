import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import {
    calculateAssessmentScore,
    formatLabel,
    type AssessmentInputs,
    type AssessmentResult,
} from "@/lib/assessment-calculator";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const OPENROUTER_TIMEOUT_MS = 12_000; // 12s timeout for LLM call

// --- Lead data constraints ---
const MAX_LEAD_FIELDS = 10;
const MAX_LEAD_VALUE_LENGTH = 500;
const ALLOWED_LEAD_FIELDS = new Set([
    "name", "email", "company", "phone", "country", "source",
]);

type LeadData = Record<string, unknown>;
type AssessmentInsights = Pick<
    AssessmentResult,
    "strategicAdvice" | "reasoning" | "nextSteps"
>;

export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => null);
        if (!isRecord(body)) {
            return jsonResponse(
                { success: false, error: "Invalid JSON payload" },
                400
            );
        }

        const { inputs, leadData, recaptchaToken } = body;
        if (!isAssessmentInputs(inputs) || !isRecord(leadData)) {
            return jsonResponse(
                { success: false, error: "Missing or invalid required fields" },
                400
            );
        }

        // --- reCAPTCHA verification ---
        const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY;
        if (recaptchaSecretKey) {
            // Token is required when the secret key is configured
            if (typeof recaptchaToken !== "string" || !recaptchaToken.trim()) {
                return jsonResponse(
                    { success: false, error: "reCAPTCHA token is required" },
                    400
                );
            }

            try {
                const verifyParams = new URLSearchParams({
                    secret: recaptchaSecretKey,
                    response: recaptchaToken,
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
                if (!recaptchaResult.success) {
                    return jsonResponse(
                        { success: false, error: "reCAPTCHA verification failed" },
                        403
                    );
                }
            } catch (error) {
                console.error("reCAPTCHA verification error:", error);
                // Fail closed: reject the request if we can't verify
                return jsonResponse(
                    { success: false, error: "reCAPTCHA verification unavailable" },
                    503
                );
            }
        }

        // Recalculate server-side so scores cannot be tampered with by the client.
        const result = calculateAssessmentScore(inputs);
        saveLeadToGoogleSheets(inputs, leadData, result);

        let mergedResult: AssessmentResult = result;
        const openRouterClient = createOpenRouterClient();
        if (openRouterClient) {
            const aiInsights = await generateAIInsights(
                openRouterClient,
                inputs,
                leadData,
                result
            );
            if (aiInsights) {
                mergedResult = {
                    ...result,
                    ...aiInsights,
                };
            }
        }

        return jsonResponse({
            success: true,
            result: mergedResult,
        });
    } catch (error) {
        console.error("Assessment API error:", error);
        return jsonResponse(
            { success: false, error: "Internal server error" },
            500
        );
    }
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 200,
        headers: CORS_HEADERS,
    });
}

function jsonResponse(
    payload: { success: boolean; result?: AssessmentResult; error?: string },
    status = 200
) {
    return NextResponse.json(payload, {
        status,
        headers: CORS_HEADERS,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssessmentInputs(value: unknown): value is AssessmentInputs {
    if (!isRecord(value)) {
        return false;
    }

    const requiredStringFields = [
        "companySize",
        "functionFocus",
        "primaryWorkflowGoal",
        "monthlyVolumeBand",
        "currentAHTBand",
        "errorTolerance",
        "dataAccessReadiness",
        "processMaturity",
        "dataStructure",
        "sponsorReady",
        "budgetFit",
    ];

    const hasRequiredStrings = requiredStringFields.every(
        (field) => typeof value[field] === "string"
    );

    return (
        hasRequiredStrings &&
        Array.isArray(value.tooling) &&
        value.tooling.every((item) => typeof item === "string")
    );
}

function saveLeadToGoogleSheets(
    inputs: AssessmentInputs,
    leadData: LeadData,
    result: AssessmentResult
) {
    const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
    if (!googleScriptUrl) {
        return;
    }

    const normalizedLeadData = normalizeLeadData(leadData);
    const payload = {
        ...normalizedLeadData,
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

    void fetch(googleScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).catch((error: unknown) => {
        console.error("Assessment lead save failed:", error);
    });
}

/**
 * Normalizes lead data with field allowlist and size constraints
 * to prevent payload bloat from malicious clients.
 */
function normalizeLeadData(
    leadData: LeadData
): Record<string, string | number | boolean> {
    const normalized: Record<string, string | number | boolean> = {};
    let fieldCount = 0;

    for (const [key, value] of Object.entries(leadData)) {
        if (fieldCount >= MAX_LEAD_FIELDS) break;
        if (!ALLOWED_LEAD_FIELDS.has(key)) continue;

        if (typeof value === "string") {
            normalized[key] = value.slice(0, MAX_LEAD_VALUE_LENGTH);
            fieldCount++;
        } else if (typeof value === "number" || typeof value === "boolean") {
            normalized[key] = value;
            fieldCount++;
        }
    }

    return normalized;
}

function createOpenRouterClient(): OpenAI | null {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return null;
    }

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

/**
 * Sanitizes a company name for safe LLM prompt inclusion.
 * Trims, truncates to 64 chars, strips control characters and
 * instruction-like tokens to mitigate prompt injection.
 */
function sanitizeCompanyName(raw: unknown): string {
    if (typeof raw !== "string") return "the company";

    let name = raw
        .trim()
        .slice(0, 64)
        // Strip control characters (U+0000–U+001F, U+007F–U+009F)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

    // Strip instruction-like patterns
    const suspiciousPatterns = /^\s*(ignore|return|stop|forget|system|assistant|you are|<\/?[a-z])/i;
    if (suspiciousPatterns.test(name) || name.includes("```") || name.includes("{") || name.includes("}")) {
        return "the company";
    }

    name = name.trim();
    return name.length > 0 ? name : "the company";
}

async function generateAIInsights(
    openai: OpenAI,
    inputs: AssessmentInputs,
    leadData: LeadData,
    result: AssessmentResult
): Promise<AssessmentInsights | null> {
    try {
        const company = sanitizeCompanyName(leadData.company);

        const prompt = `
Company: ${company}
Size: ${inputs.companySize}
Function: ${formatLabel(inputs.functionFocus)}
Goal: ${formatLabel(inputs.primaryWorkflowGoal)}
Volume: ${inputs.monthlyVolumeBand}
AHT: ${inputs.currentAHTBand}
Process maturity: ${inputs.processMaturity}
Data structure: ${inputs.dataStructure}
Data access readiness: ${inputs.dataAccessReadiness}
Tooling: ${inputs.tooling.length > 0 ? inputs.tooling.join(", ") : "None listed"}

Scores:
- Viability: ${result.viabilityScore}/100
- Readiness: ${result.readinessScore}/100
- Risk: ${result.riskScore}/100
- Archetype: ${result.archetypeTitle}
`;

        const completion = await openai.chat.completions.create({
            model: OPENROUTER_MODEL,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content:
                        "You are a senior AI automation consultant. Return strict JSON only with keys strategicAdvice, reasoning, nextSteps.",
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
        if (!rawContent) {
            return null;
        }

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

        const strategicAdvice = parsed.strategicAdvice.trim();

        if (!strategicAdvice || reasoning.length === 0 || nextSteps.length === 0) {
            return null;
        }

        return {
            strategicAdvice,
            reasoning,
            nextSteps,
        };
    } catch (error) {
        console.error("AI insight generation failed:", error);
        return null;
    }
}
