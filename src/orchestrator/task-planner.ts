import type { AgentRole } from "../agents/roles.js";
import type { AgentProvider } from "../agents/agent.js";

export interface TaskPlan {
  task: string;
  phases: TaskPhase[];
}

export interface TaskPhase {
  name: string;
  agents: AgentAssignment[];
  description: string;
}

export interface AgentAssignment {
  role: AgentRole;
  provider?: AgentProvider;
  prompt: string;
}

/**
 * Maps a user task to a multi-agent execution plan.
 * The System Designer (slot 0) will refine these plans,
 * but this provides the initial structure.
 */
export function planTask(task: string): TaskPlan {
  const lower = task.toLowerCase();

  // Security / vulnerability tasks
  if (lower.includes("vulnerabilit") || lower.includes("security") || lower.includes("audit") || lower.includes("pen test")) {
    return {
      task,
      phases: [
        {
          name: "Security Audit",
          description: "Run comprehensive security analysis",
          agents: [
            {
              role: "security",
              prompt: `Perform a thorough security audit: ${task}. Run npm audit, check for compromised packages (especially axios), scan for hardcoded secrets, check .env exposure, review auth flows. Report all findings in a structured table.`,
            },
            {
              role: "pen-tester",
              prompt: `Actively probe for vulnerabilities related to: ${task}. Test for injection vectors, auth bypasses, path traversal, IDOR. Try to find what the security reviewer might miss. Report findings with severity, vector, impact, and fix.`,
            },
          ],
        },
      ],
    };
  }

  // Build / feature tasks
  if (lower.includes("build") || lower.includes("implement") || lower.includes("create") || lower.includes("add")) {
    return {
      task,
      phases: [
        {
          name: "Design",
          description: "Architecture and system design",
          agents: [
            {
              role: "system-designer",
              prompt: `Design the architecture for: ${task}. Create a system design with data models, API contracts, and implementation plan. Then delegate to @backend and @frontend.`,
            },
          ],
        },
        {
          name: "Implementation",
          description: "Parallel frontend + backend development",
          agents: [
            {
              role: "backend",
              prompt: `Implement the backend for: ${task}. Follow the system design from the System Designer. Write clean TypeScript, use native fetch (never axios), and write tests.`,
            },
            {
              role: "frontend",
              prompt: `Implement the frontend for: ${task}. Follow the system design from the System Designer. Build responsive UI components.`,
            },
          ],
        },
        {
          name: "Validation",
          description: "Testing and security review",
          agents: [
            {
              role: "e2e-tester",
              prompt: `Write and run end-to-end tests for: ${task}. Cover happy paths, edge cases, and error scenarios.`,
            },
            {
              role: "security",
              prompt: `Review the implementation of: ${task} for security issues. Check for injection, auth problems, and data exposure.`,
            },
          ],
        },
      ],
    };
  }

  // Research tasks
  if (lower.includes("research") || lower.includes("investigate") || lower.includes("analyze") || lower.includes("find")) {
    return {
      task,
      phases: [
        {
          name: "Research",
          description: "Deep investigation",
          agents: [
            {
              role: "ai-ml-researcher",
              prompt: `Research: ${task}. Search the web, analyze options, compare approaches. Produce a structured report with recommendations.`,
            },
          ],
        },
      ],
    };
  }

  // DevOps / deployment tasks
  if (lower.includes("deploy") || lower.includes("ci/cd") || lower.includes("pipeline") || lower.includes("docker")) {
    return {
      task,
      phases: [
        {
          name: "Infrastructure",
          description: "DevOps and CI/CD setup",
          agents: [
            {
              role: "devops-mlops",
              prompt: `Set up infrastructure for: ${task}. Configure deployment, monitoring, and automation.`,
            },
            {
              role: "cicd",
              prompt: `Create CI/CD pipeline for: ${task}. Set up GitHub Actions, testing, and deployment automation.`,
            },
          ],
        },
      ],
    };
  }

  // Default: let System Designer figure it out
  return {
    task,
    phases: [
      {
        name: "Analysis",
        description: "System Designer analyzes and plans",
        agents: [
          {
            role: "system-designer",
            prompt: `Analyze this task and create an implementation plan: ${task}. Determine which specialists are needed and create detailed assignments for each.`,
          },
        ],
      },
    ],
  };
}
