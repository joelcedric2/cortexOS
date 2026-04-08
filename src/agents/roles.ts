export type AgentRole =
  | "system-designer"
  | "frontend"
  | "backend"
  | "security"
  | "e2e-tester"
  | "internal-apis"
  | "cicd"
  | "devops-mlops"
  | "ai-ml-researcher"
  | "visual-tester"
  | "security-reviewer"
  | "pen-tester";

export interface RoleDefinition {
  role: AgentRole;
  shortCode: string; // e.g. "RES", "FDD", "BKD" — used for agent IDs like RES0, FDD1
  displayName: string;
  description: string;
  defaultProvider: "claude" | "gemini" | "codex";
  configFile: string;
}

/** Instance counter per role for generating unique IDs like FDD0, FDD1 */
const instanceCounters: Partial<Record<AgentRole, number>> = {};

export function nextAgentId(role: AgentRole): string {
  const def = ROLE_DEFINITIONS[role];
  const count = instanceCounters[role] ?? 0;
  instanceCounters[role] = count + 1;
  return `${def.shortCode}${count}`;
}

export function resetInstanceCounter(role: AgentRole): void {
  instanceCounters[role] = 0;
}

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  "system-designer": {
    role: "system-designer",
    shortCode: "RES",
    displayName: "Researcher & System Designer",
    description: "Researches the task, creates the plan, delegates to specialists, consolidates results",
    defaultProvider: "claude",
    configFile: "system-designer.md",
  },
  frontend: {
    role: "frontend",
    shortCode: "FDD",
    displayName: "Frontend Dev",
    description: "UI/UX implementation, component architecture, styling",
    defaultProvider: "claude",
    configFile: "frontend.md",
  },
  backend: {
    role: "backend",
    shortCode: "BKD",
    displayName: "Backend Dev",
    description: "APIs, databases, server-side logic, integrations",
    defaultProvider: "claude",
    configFile: "backend.md",
  },
  security: {
    role: "security",
    shortCode: "SET",
    displayName: "Security Expert",
    description: "Threat modeling, secure coding, vulnerability assessment",
    defaultProvider: "claude",
    configFile: "security.md",
  },
  "e2e-tester": {
    role: "e2e-tester",
    shortCode: "E2E",
    displayName: "E2E Tester",
    description: "End-to-end testing, integration tests, test automation",
    defaultProvider: "claude",
    configFile: "e2e-tester.md",
  },
  "internal-apis": {
    role: "internal-apis",
    shortCode: "API",
    displayName: "Internal APIs Engineer",
    description: "Internal service APIs, gRPC, message queues, contracts",
    defaultProvider: "claude",
    configFile: "internal-apis.md",
  },
  cicd: {
    role: "cicd",
    shortCode: "CCD",
    displayName: "CI/CD Engineer",
    description: "Build pipelines, deployment automation, GitHub Actions",
    defaultProvider: "gemini",
    configFile: "cicd.md",
  },
  "devops-mlops": {
    role: "devops-mlops",
    shortCode: "DVO",
    displayName: "DevOps/MLOps Engineer",
    description: "Infrastructure, containers, ML pipelines, monitoring",
    defaultProvider: "gemini",
    configFile: "devops-mlops.md",
  },
  "ai-ml-researcher": {
    role: "ai-ml-researcher",
    shortCode: "MLR",
    displayName: "AI/ML Researcher",
    description: "Model research, evaluation, prompt engineering, RAG",
    defaultProvider: "claude",
    configFile: "ai-ml-researcher.md",
  },
  "visual-tester": {
    role: "visual-tester",
    shortCode: "VIT",
    displayName: "Visual Tester",
    description: "Screen-records 10s clips, processes video for visual regressions",
    defaultProvider: "gemini",
    configFile: "visual-tester.md",
  },
  "security-reviewer": {
    role: "security-reviewer",
    shortCode: "SRV",
    displayName: "Security Reviewer",
    description: "Second-opinion code review from different model family for better coverage",
    defaultProvider: "codex",
    configFile: "security-reviewer.md",
  },
  "pen-tester": {
    role: "pen-tester",
    shortCode: "PET",
    displayName: "Penetration Tester",
    description: "Actively probes for vulnerabilities, injection vectors, auth bypasses",
    defaultProvider: "claude",
    configFile: "pen-tester.md",
  },
};

export function getRoleDefinition(role: AgentRole): RoleDefinition {
  return ROLE_DEFINITIONS[role];
}

export function isValidRole(role: string): role is AgentRole {
  return role in ROLE_DEFINITIONS;
}
