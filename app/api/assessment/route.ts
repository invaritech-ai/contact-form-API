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
const GOOGLE_SCRIPT_TIMEOUT_MS = 8_000;
const MAX_ENUM_INPUT_LENGTH = 64;
const MAX_COMPANY_NAME_LENGTH = 64;
const MAX_STRATEGIC_ADVICE_LENGTH = 2_000;
const COMPANY_PLACEHOLDER = "the company";

// --- Lead data constraints ---
const MAX_LEAD_FIELDS = 10;
const MAX_LEAD_VALUE_LENGTH = 500;
const ALLOWED_LEAD_FIELDS = new Set([
    "name", "email", "company", "phone", "country", "source",
]);
const MAX_TOOLING_ITEMS = 10;

const ALLOWED_COMPANY_SIZES = [
    "50-200",
    "200-500",
    "500-1000",
    "1000-2000",
    "2000+",
] as const;
const ALLOWED_FUNCTION_FOCUS = [
    "customer-support",
    "sales",
    "operations",
    "marketing",
    "finance",
    "legal",
    "health-fitness",
    "hr",
    "it",
    "product",
    "engineering",
    "analytics",
] as const;
const ALLOWED_PRIMARY_WORKFLOW_GOALS = [
    "knowledge",
    "drafting",
    "intake",
    "finance",
    "lead-qualification",
    "client-onboarding",
    "scheduling",
    "reporting",
    "content-generation",
] as const;
const ALLOWED_MONTHLY_VOLUME_BANDS = [
    "100-500",
    "500-1000",
    "1000-2000",
    "2000-5000",
    "5000+",
] as const;
const ALLOWED_CURRENT_AHT_BANDS = [
    "<1 min",
    "1-3 min",
    "3-5 min",
    "5+ min",
] as const;
const ALLOWED_ERROR_TOLERANCES = [
    "minimal",
    "rework",
    "critical",
] as const;
const ALLOWED_DATA_ACCESS_READINESS = [
    "minimal",
    "synthetic",
    "blocked",
] as const;
const ALLOWED_PROCESS_MATURITY = [
    "documented",
    "partial",
    "tribal",
] as const;
const ALLOWED_DATA_STRUCTURES = [
    "structured",
    "semi",
    "unstructured",
    "scattered",
] as const;
const ALLOWED_SPONSOR_READINESS = [
    "yes",
    "partial",
    "no",
] as const;
const ALLOWED_BUDGET_FITS = [
    "<$10k",
    "$10-25k",
    "≥$25k",
] as const;
const ALLOWED_TOOLING = [
    "salesforce",
    "hubspot",
    "slack",
    "teams",
    "zendesk",
    "intercom",
    "notion",
    "airtable",
    "jira",
    "asana",
    "google-workspace",
    "microsoft-365",
    "zapier",
    "make",
    "n8n",
    "shopify",
    "stripe",
    "quickbooks",
    "netsuite",
    "none",
] as const;

const COMPANY_SIZE_LOOKUP = createEnumLookup(ALLOWED_COMPANY_SIZES);
const FUNCTION_FOCUS_LOOKUP = createEnumLookup(ALLOWED_FUNCTION_FOCUS);
const PRIMARY_WORKFLOW_GOAL_LOOKUP = createEnumLookup(ALLOWED_PRIMARY_WORKFLOW_GOALS);
const MONTHLY_VOLUME_BAND_LOOKUP = createEnumLookup(ALLOWED_MONTHLY_VOLUME_BANDS);
const CURRENT_AHT_BAND_LOOKUP = createEnumLookup(ALLOWED_CURRENT_AHT_BANDS);
const ERROR_TOLERANCE_LOOKUP = createEnumLookup(ALLOWED_ERROR_TOLERANCES);
const DATA_ACCESS_READINESS_LOOKUP = createEnumLookup(ALLOWED_DATA_ACCESS_READINESS);
const PROCESS_MATURITY_LOOKUP = createEnumLookup(ALLOWED_PROCESS_MATURITY);
const DATA_STRUCTURE_LOOKUP = createEnumLookup(ALLOWED_DATA_STRUCTURES);
const SPONSOR_READINESS_LOOKUP = createEnumLookup(ALLOWED_SPONSOR_READINESS);
const BUDGET_FIT_LOOKUP = createEnumLookup(ALLOWED_BUDGET_FITS);
const TOOLING_LOOKUP = createEnumLookup(ALLOWED_TOOLING);

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

        const { inputs: rawInputs, leadData, recaptchaToken } = body;
        const inputs = normalizeAssessmentInputs(rawInputs);
        if (!inputs || !isRecord(leadData)) {
            return jsonResponse(
                { success: false, error: "Missing or invalid required fields" },
                400
            );
        }

        // --- reCAPTCHA verification (fail-closed to prevent bot submissions) ---
        const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY?.trim();
        if (!recaptchaSecretKey) {
            return jsonResponse(
                { success: false, error: "reCAPTCHA is not configured" },
                503
            );
        }

        const normalizedRecaptchaToken =
            typeof recaptchaToken === "string" ? recaptchaToken.trim() : "";
        if (!normalizedRecaptchaToken) {
            return jsonResponse(
                { success: false, error: "reCAPTCHA token is required" },
                400
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
            captchaStatus = "Verified";
        } catch (error) {
            console.error("reCAPTCHA verification error:", error);
            return jsonResponse(
                { success: false, error: "reCAPTCHA verification unavailable" },
                503
            );
        }

        // Recalculate server-side so scores cannot be tampered with by the client.
        const result = calculateAssessmentScore(inputs);
        await saveLeadToGoogleSheets(inputs, leadData, result, captchaStatus);

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

function createEnumLookup(
    values: readonly string[]
): Map<string, string> {
    return new Map(values.map((value) => [value.toLowerCase(), value]));
}

function sanitizeInputText(raw: unknown, maxLength: number): string {
    if (typeof raw !== "string") {
        return "";
    }

    return raw
        .normalize("NFKC")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally stripping C0/C1 control characters
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
        .trim();
}

function normalizeEnumValue(
    raw: unknown,
    lookup: ReadonlyMap<string, string>,
    options: { slugStyle?: boolean } = {}
): string | null {
    const sanitized = sanitizeInputText(raw, MAX_ENUM_INPUT_LENGTH);
    if (!sanitized) {
        return null;
    }

    const lookupKey = options.slugStyle
        ? sanitized.toLowerCase().replace(/[_\s]+/g, "-")
        : sanitized.toLowerCase();

    return lookup.get(lookupKey) ?? null;
}

function normalizeToolingItems(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    const normalized = new Set<string>();
    for (const item of raw) {
        const normalizedItem = normalizeEnumValue(item, TOOLING_LOOKUP, {
            slugStyle: true,
        });

        // Unexpected tooling values are dropped to avoid prompt injection.
        if (!normalizedItem) {
            continue;
        }

        normalized.add(normalizedItem);
        if (normalized.size >= MAX_TOOLING_ITEMS) {
            break;
        }
    }

    return Array.from(normalized);
}

function normalizeAssessmentInputs(value: unknown): AssessmentInputs | null {
    if (!isRecord(value)) {
        return null;
    }

    const companySize = normalizeEnumValue(value.companySize, COMPANY_SIZE_LOOKUP);
    const functionFocus = normalizeEnumValue(value.functionFocus, FUNCTION_FOCUS_LOOKUP, {
        slugStyle: true,
    });
    const primaryWorkflowGoal = normalizeEnumValue(
        value.primaryWorkflowGoal,
        PRIMARY_WORKFLOW_GOAL_LOOKUP,
        { slugStyle: true }
    );
    const monthlyVolumeBand = normalizeEnumValue(
        value.monthlyVolumeBand,
        MONTHLY_VOLUME_BAND_LOOKUP
    );
    const currentAHTBand = normalizeEnumValue(
        value.currentAHTBand,
        CURRENT_AHT_BAND_LOOKUP
    );
    const errorTolerance = normalizeEnumValue(value.errorTolerance, ERROR_TOLERANCE_LOOKUP, {
        slugStyle: true,
    });
    const dataAccessReadiness = normalizeEnumValue(
        value.dataAccessReadiness,
        DATA_ACCESS_READINESS_LOOKUP,
        { slugStyle: true }
    );
    const processMaturity = normalizeEnumValue(value.processMaturity, PROCESS_MATURITY_LOOKUP, {
        slugStyle: true,
    });
    const dataStructure = normalizeEnumValue(value.dataStructure, DATA_STRUCTURE_LOOKUP, {
        slugStyle: true,
    });
    const sponsorReady = normalizeEnumValue(value.sponsorReady, SPONSOR_READINESS_LOOKUP, {
        slugStyle: true,
    });
    const budgetFit = normalizeEnumValue(value.budgetFit, BUDGET_FIT_LOOKUP);
    const tooling = normalizeToolingItems(value.tooling);

    if (
        !companySize ||
        !functionFocus ||
        !primaryWorkflowGoal ||
        !monthlyVolumeBand ||
        !currentAHTBand ||
        !errorTolerance ||
        !dataAccessReadiness ||
        !processMaturity ||
        !dataStructure ||
        !sponsorReady ||
        !budgetFit ||
        tooling === null
    ) {
        return null;
    }

    return {
        companySize,
        functionFocus,
        primaryWorkflowGoal,
        monthlyVolumeBand,
        currentAHTBand,
        errorTolerance,
        dataAccessReadiness,
        processMaturity,
        dataStructure,
        sponsorReady,
        budgetFit,
        tooling,
    };
}

function saveLeadToGoogleSheets(
    inputs: AssessmentInputs,
    leadData: LeadData,
    result: AssessmentResult,
    captchaStatus: "Verified" | "Not verified"
): Promise<void> {
    const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
    const googleScriptWebhookSecret =
        process.env.GOOGLE_SCRIPT_WEBHOOK_SECRET?.trim();
    if (!googleScriptUrl) {
        return Promise.resolve();
    }
    if (!googleScriptWebhookSecret) {
        console.error(
            "GOOGLE_SCRIPT_WEBHOOK_SECRET is not configured; skipping assessment lead save"
        );
        return Promise.resolve();
    }

    const normalizedLeadData = normalizeLeadData(leadData);
    const assessmentSummary = [
        `Target Function: ${formatLabel(inputs.functionFocus)}`,
        `Primary Goal: ${formatLabel(inputs.primaryWorkflowGoal)}`,
        `Company Size: ${inputs.companySize}`,
        `Volume: ${inputs.monthlyVolumeBand}`,
        `AHT: ${inputs.currentAHTBand}`,
        `Data Structure: ${inputs.dataStructure}`,
        `Process Maturity: ${inputs.processMaturity}`,
        `Data Readiness: ${inputs.dataAccessReadiness}`,
        `Tooling: ${inputs.tooling.join(", ")}`,
        `---`,
        `Archetype: ${result.archetypeTitle}`,
        `Scores - Viability: ${result.viabilityScore}, Readiness: ${result.readinessScore}, Risk: ${result.riskScore}`
    ].join("\n");

    const payload = {
        ...normalizedLeadData,
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
                statusText: response.statusText,
                body,
            });
        }
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
    const name = sanitizeInputText(raw, MAX_COMPANY_NAME_LENGTH);

    if (!name || hasSuspiciousPromptTokens(name)) {
        return COMPANY_PLACEHOLDER;
    }

    return name;
}

function hasSuspiciousPromptTokens(value: string): boolean {
    // Instruction-like prefixes that often indicate prompt injection.
    if (/^(ignore|return|stop|forget|system|assistant|developer|instruction|prompt)\b/i.test(value)) {
        return true;
    }

    // Embedded JSON/code/command-like patterns.
    return (
        /```/.test(value) ||
        /[{\[]\s*["'][^"']+["']\s*:/.test(value) ||
        /<\/?(system|assistant|user|tool|script)\b/i.test(value) ||
        /(\|\||&&|;\s*(rm|curl|wget|bash|sh|python|node)\b|\$\(|`)/i.test(value)
    );
}

async function generateAIInsights(
    openai: OpenAI,
    inputs: AssessmentInputs,
    leadData: LeadData,
    result: AssessmentResult
): Promise<AssessmentInsights | null> {
    try {
        const company = sanitizeCompanyName(leadData.company);
        const companySize = inputs.companySize;
        const functionFocus = formatLabel(inputs.functionFocus);
        const primaryWorkflowGoal = formatLabel(inputs.primaryWorkflowGoal);
        const monthlyVolumeBand = inputs.monthlyVolumeBand;
        const currentAHTBand = inputs.currentAHTBand;
        const processMaturity = formatLabel(inputs.processMaturity);
        const dataStructure = formatLabel(inputs.dataStructure);
        const dataAccessReadiness = formatLabel(inputs.dataAccessReadiness);
        const tooling = inputs.tooling.length > 0
            ? inputs.tooling.map((item) => formatLabel(item)).join(", ")
            : "None listed";

        const prompt = `
Company: ${company}
Size: ${companySize}
Function: ${functionFocus}
Goal: ${primaryWorkflowGoal}
Volume: ${monthlyVolumeBand}
AHT: ${currentAHTBand}
Process maturity: ${processMaturity}
Data structure: ${dataStructure}
Data access readiness: ${dataAccessReadiness}
Tooling: ${tooling}

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

        const strategicAdvice = parsed.strategicAdvice
            .trim()
            .slice(0, MAX_STRATEGIC_ADVICE_LENGTH);

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
