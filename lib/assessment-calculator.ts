/** Config for savings calculations. Default standardFteHourlyRate: $65 */
export interface AssessmentCalculatorConfig {
    standardFteHourlyRate?: number;
}

export interface AssessmentInputs {
    // 1. Context & Viability
    companySize: string;
    functionFocus: string;
    primaryWorkflowGoal: string;
    monthlyVolumeBand: string;
    currentAHTBand: string;
    errorTolerance: string; // NEW: Impact of errors

    // 2. Readiness & Tech
    tooling: string[];
    dataAccessReadiness: string;
    processMaturity: string; // NEW: Is it documented?
    dataStructure: string; // NEW: Where is the data?

    // 3. Commercial
    sponsorReady: string;
    budgetFit: string;
}

export type AssessmentTier = "hot" | "warm" | "cold";
export type AssessmentArchetype =
    | "velocity-architect"
    | "augmentation-strategist"
    | "foundation-builder"
    | "opportunity-accelerator"
    | "explorer";

export interface AssessmentResult {
    // Scores (0-100)
    viabilityScore: number;
    readinessScore: number;
    riskScore: number;

    // Classification
    tier: AssessmentTier;
    archetype: AssessmentArchetype;
    archetypeTitle: string;
    archetypeDescription: string;

    // Stats
    projectedHoursSaved: {
        min: number;
        max: number;
        // The theoretical max if readiness was 100%
        theoreticalMax: number;
    };
    projectedCostAvoided: {
        min: number;
        max: number;
    };

    // Metadata for breakdown
    calculationBasis: {
        monthlyVolume: number;
        averageAHT: number;
        efficiencyGain: number;
        readinessFactor: number;
        hourlyRate: number;
        functionFocus: string;
    };

    // Feedback
    reasoning: string[];
    nextSteps: string[];
    strategicAdvice: string; // Detailed paragraph
}

export function calculateAssessmentScore(
    inputs: AssessmentInputs,
    config: AssessmentCalculatorConfig = {}
): AssessmentResult {
    const reasoning: string[] = [];
    const nextSteps: string[] = [];

    // --- 1. Calculate Viability Score (Impact) ---
    // Factors: Volume, AHT, Workflow Value, Budget
    let viabilityRaw = 0;

    // Volume (Max 30)
    switch (inputs.monthlyVolumeBand) {
        case "5000+":
            viabilityRaw += 30;
            reasoning.push("High scale offers massive ROI potential.");
            break;
        case "2000-5000":
            viabilityRaw += 25;
            break;
        case "1000-2000":
            viabilityRaw += 20;
            break;
        case "500-1000":
            viabilityRaw += 15;
            break;
        default:
            viabilityRaw += 5;
    }

    // AHT (Max 25)
    switch (inputs.currentAHTBand) {
        case "5+ min":
            viabilityRaw += 25;
            reasoning.push(
                "Complex, lengthy tasks are prime candidates for AI optimization."
            );
            break;
        case "3-5 min":
            viabilityRaw += 20;
            break;
        case "1-3 min":
            viabilityRaw += 15;
            break;
        default:
            viabilityRaw += 5;
    }

    // Workflow Value (Max 25)
    // Updated with new verticals
    const goalScore = getWorkflowGoalScore(inputs.primaryWorkflowGoal);
    viabilityRaw += goalScore.score;
    if (goalScore.reason) reasoning.push(goalScore.reason);

    // Budget (Max 20)
    switch (inputs.budgetFit) {
        case "≥$25k":
            viabilityRaw += 20;
            break;
        case "$10-25k":
            viabilityRaw += 10;
            break;
        case "<$10k":
            viabilityRaw += 0;
            nextSteps.push("Start with a small, scoped pilot to prove ROI before scaling.");
            break;
    }

    // Company Size (Max 5) - larger orgs have more runway for pilots
    switch (inputs.companySize) {
        case "2000+":
            viabilityRaw += 5;
            break;
        case "1000-2000":
        case "500-1000":
            viabilityRaw += 3;
            break;
        case "200-500":
        case "50-200":
            viabilityRaw += 0;
            break;
        default:
            break;
    }

    const viabilityScore = Math.min(viabilityRaw, 100);

    // --- 2. Calculate Readiness Score (Feasibility) ---
    // Factors: Process Maturity, Data Structure, Data Access, Tooling
    let readinessRaw = 0;

    // Process Maturity (Max 30) - CRITICAL
    switch (inputs.processMaturity) {
        case "documented":
            readinessRaw += 30;
            reasoning.push(
                "Documented SOPs significantly accelerate implementation speed."
            );
            break;
        case "partial":
            readinessRaw += 15;
            nextSteps.push(
                "Formalize process documentation for your primary workflow."
            );
            break;
        case "tribal": // In heads
        default:
            readinessRaw += 5;
            reasoning.push(
                "Tribal knowledge processes require a 'Discovery & Definition' phase first."
            );
            nextSteps.push("Interview your best agents to document the 'happy path' workflow.");
    }

    // Data Structure (Max 25)
    switch (inputs.dataStructure) {
        case "structured": // SQL/API
            readinessRaw += 25;
            reasoning.push("Structured data allows for high-precision automation.");
            break;
        case "semi": // Spreadsheets
            readinessRaw += 15;
            break;
        case "unstructured": // PDFs/Docs
            readinessRaw += 10;
            break;
        case "scattered": // Emails/Chat
        default:
            readinessRaw += 0;
            reasoning.push(
                "Centralizing dispersed data sources will be a necessary first step."
            );
            nextSteps.push("Consolidate training data from scattered sources into a central repository.");
    }

    // Data Access (Max 25)
    switch (inputs.dataAccessReadiness) {
        case "minimal":
            readinessRaw += 25;
            break; 
        case "synthetic":
            readinessRaw += 20;
            reasoning.push("Synthetic data is a great way to start development safely.");
            break;
        case "blocked":
            readinessRaw += 0;
            reasoning.push("Strict data blocking requires specialized on-prem or local-LLM architectures.");
            nextSteps.push("Investigate options for a secure sandbox environment.");
            break;
        default:
            readinessRaw += 10;
    }

    // Tooling (Max 20)
    const toolingCount = inputs.tooling.length;
    if (toolingCount >= 3) {
        readinessRaw += 20;
        reasoning.push("Strong tooling ecosystem allows for powerful integrations.");
    } else if (toolingCount >= 1) {
        readinessRaw += 10;
    } else {
        readinessRaw += 0;
    }

    // Tooling specific feedback
    if (inputs.tooling.includes("salesforce") || inputs.tooling.includes("hubspot")) {
        reasoning.push("CRM integration enables direct pipeline automation.");
    }
    if (inputs.tooling.includes("slack") || inputs.tooling.includes("teams")) {
        reasoning.push("Chat platform presence allows for 'Human-in-the-Loop' agent patterns.");
    }

    const readinessScore = Math.min(readinessRaw, 100);

    // --- 3. Calculate Risk Score (Complexity/Safety) ---
    // Factors: Error Tolerance, Data Structure, Workflow Goal 
    // Start at 0, add risk.
    let riskRaw = 0; 

    // Error Tolerance
    switch (inputs.errorTolerance) {
        case "critical":
            riskRaw += 40; // High risk environment
            reasoning.push("Zero-tolerance for error requires strict Human-in-the-Loop guardrails.");
            break;
        case "rework":
            riskRaw += 20;
            break;
        case "minimal":
            riskRaw += 0; // Low risk
            break;
    }

    // Data Structure - scattered/unstructured adds risk (hallucination risk)
    switch (inputs.dataStructure) {
        case "scattered":
            riskRaw += 15;
            break;
        case "unstructured":
            riskRaw += 10;
            break;
        case "semi":
            riskRaw += 5;
            break;
        default:
            break; // Structured is low risk
    }

    // Workflow Goal - finance/legal/health implies higher stakes
    const highRiskDomains = ["finance", "legal", "health-fitness"];
    if (highRiskDomains.includes(inputs.functionFocus) || inputs.primaryWorkflowGoal === "finance") {
        riskRaw += 15;
        reasoning.push("Regulated or high-stakes domains require auditable AI reasoning logs.");
    }

    const riskScore = Math.min(riskRaw, 100);

    // --- 4. Determine Archetype & Tier ---

    let archetype: AssessmentArchetype = "explorer";
    let tier: AssessmentTier = "cold";
    let title = "The Explorer";
    let description = "You're at the beginning of your automation journey.";
    let strategicAdvice = ""; // Fallback text

    // Logic for Archetypes
    if (viabilityScore > 70 && readinessScore > 70) {
        // High Viability + High Readiness
        if (riskScore > 50) {
            archetype = "augmentation-strategist";
            title = "The Augmentation Strategist";
            description = "High-value, complex workflows requiring expert human oversight enabled by AI.";
            strategicAdvice = `Your ${formatLabel(inputs.functionFocus)} workflow is high-value but carries complexity. The optimal path isn't full replacement, but 'Super-Agent' augmentation—building copilots that handle the heavy lifting while keeping a human in the loop for the final decision.`;
            tier = "hot";
        } else {
            archetype = "velocity-architect";
            title = "The Velocity Architect";
            description = "Prime candidate for high-speed, autonomous agentic workflows.";
            strategicAdvice = `You have the perfect storm for automation: high volume, well-documented processes, and a tolerance for iteration. You are ready to deploy autonomous agents that can execute end-to-end tasks with minimal supervision, potentially unlocking 10x operational throughput.`;
            tier = "hot";
        }
    } else if (viabilityScore > 60 && readinessScore < 70) {
        // Worth doing, but not ready
        archetype = "foundation-builder";
        title = "The Foundation Builder";
        description = "High potential that needs infrastructure investment first.";
        strategicAdvice = `The ROI potential is clearly there, but your data or process maturity isn't quite ready for advanced AI agents yet. Jumping straight to code would be risky. The winning move is a 'Foundation Sprint'—formalizing your SOPs and data, then layering AI on top.`;
        tier = "warm";
    } else if (viabilityScore > 60 && readinessScore >= 70) {
        // Ready, but maybe moderate ROI
        archetype = "opportunity-accelerator";
        title = "The Opportunity Accelerator";
        description = "Strong operational readiness with moderate ROI — ready to fast-track.";
        strategicAdvice = `Your team's readiness is strong, which means you can move fast. The current workflow may not be the highest-ROI target, but your infrastructure gives you leverage. A focused 'Opportunity Audit' can identify the bottleneck where this readiness will deliver disproportionate impact.`;
        tier = "warm";
    } else {
        // Low viability OR very early
        archetype = "explorer";
        title = "The Explorer";
        description = "Early stage discovery to identify the right use cases.";
        strategicAdvice = `It seems this specific workflow might not yield the massive ROI typical of custom AI development just yet. We recommend a lower-investment 'Discovery Phase' to audit your wider operations and find the hidden high-value bottlenecks before committing to a build.`;
        tier = "cold";
    }

    // --- 5. Savings Calculations ---
    const volNum = getAverageVolume(inputs.monthlyVolumeBand);
    const ahtNum = getAverageAHT(inputs.currentAHTBand);
    const { savings: efficiencyGain } = getWorkflowSavingsParams(inputs.primaryWorkflowGoal);
    const hourlyRate = config.standardFteHourlyRate ?? 65;

    const { min: minHours, max: maxHours, theoreticalMax, readinessFactor } = calculateHoursSaved(inputs, readinessScore);
    const projectedHoursSaved = { min: minHours, max: maxHours, theoreticalMax };
    const projectedCostAvoided = calculateCostAvoidance(projectedHoursSaved, hourlyRate);

    // Filter reasoning/nextSteps to be unique and max 5 items
    const uniqueReasoning = Array.from(new Set(reasoning)).slice(0, 5);
    const uniqueNextSteps = Array.from(new Set(nextSteps)).slice(0, 5);

    return {
        viabilityScore,
        readinessScore,
        riskScore,
        tier,
        archetype,
        archetypeTitle: title,
        archetypeDescription: description,
        projectedHoursSaved,
        projectedCostAvoided,
        calculationBasis: {
            monthlyVolume: volNum,
            averageAHT: ahtNum,
            efficiencyGain,
            readinessFactor,
            hourlyRate,
            functionFocus: inputs.functionFocus,
        },
        reasoning: uniqueReasoning,
        nextSteps: uniqueNextSteps,
        strategicAdvice
    };
}

// Helpers

export function calculateHoursSaved(
    inputs: AssessmentInputs, 
    readinessScore: number
): { min: number; max: number; theoreticalMax: number; readinessFactor: number } {
    const volNum = getAverageVolume(inputs.monthlyVolumeBand);
    const ahtNum = getAverageAHT(inputs.currentAHTBand);
    const { savings, automationFriction } = getWorkflowSavingsParams(inputs.primaryWorkflowGoal);

    // Theoretical max (perfect readiness)
    const minutesSavedPerCase = ahtNum * savings;
    const frictionFactor = 1 - automationFriction;
    let baseHoursSaved = (volNum * minutesSavedPerCase) / 60 * frictionFactor;

    const theoreticalMax = Math.round(baseHoursSaved);

    // Apply readiness discount
    // If readiness is 50%, you might only capture 70% of the potential savings initially
    // Formula: Cap at 100% readiness. Floor at 40% (even bad processes save something).
    const readinessFactor = Math.max(0.4, Math.min(1, readinessScore / 100 + 0.2));
    
    baseHoursSaved = baseHoursSaved * readinessFactor;

    // Min/max range
    const min = Math.round(baseHoursSaved * 0.85);
    const max = Math.round(baseHoursSaved * 1.15);
    return { min, max, theoreticalMax, readinessFactor };
}

export function calculateCostAvoidance(
    hoursSaved: { min: number; max: number },
    standardFteHourlyRate: number
): { min: number; max: number } {
    return {
        min: Math.round(hoursSaved.min * standardFteHourlyRate),
        max: Math.round(hoursSaved.max * standardFteHourlyRate),
    };
}

function getWorkflowGoalScore(goal: string): { score: number; reason?: string } {
    switch (goal) {
        case "knowledge":
            return { score: 25, reason: "Knowledge retrieval is a classic high-ROI AI use case." };
        case "drafting":
            return { score: 20 };
        case "intake":
            return { score: 20 };
        case "finance":
            return { score: 15 };
        case "lead-qualification": // SALES
            return { score: 25, reason: "Automating lead qual significantly increases conversion rates." };
        case "client-onboarding": // SALES/CS
            return { score: 20 };
        case "scheduling": // OPS
            return { score: 15 };
        case "reporting": // ANALYTICS
            return { score: 20 };
        case "content-generation": // MARKETING
            return { score: 20, reason: "AI content generation offers massive scale advantages." };
        default:
            return { score: 10 };
    }
}

function getWorkflowSavingsParams(primaryWorkflowGoal: string): {
    savings: number;
    automationFriction: number;
} {
    switch (primaryWorkflowGoal) {
        case "knowledge":
        case "reporting":
            return { savings: 0.9, automationFriction: 0.05 };
        case "drafting":
        case "content-generation":
            return { savings: 0.7, automationFriction: 0.15 };
        case "lead-qualification":
        case "scheduling":
            return { savings: 0.8, automationFriction: 0.1 };
        case "intake":
        case "finance":
        case "client-onboarding":
        default:
            return { savings: 0.6, automationFriction: 0.15 };
    }
}

function getAverageVolume(band: string): number {
    switch (band) {
        case "5000+": return 6000;
        case "2000-5000": return 3500;
        case "1000-2000": return 1500;
        case "500-1000": return 750;
        case "100-500": return 300;
        default: return 100;
    }
}

function getAverageAHT(band: string): number {
    switch (band) {
        case "5+ min": return 8; // avg
        case "3-5 min": return 4;
        case "1-3 min": return 2;
        case "<1 min": return 0.5;
        default: return 5;
    }
}

export function formatLabel(slug: string): string {
    if (!slug) return "Unknown";
    return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
