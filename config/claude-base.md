# CortexOS Agent Configuration

## Hard Rules (Always Enforced)

### Commit Hygiene
- NEVER add Co-Authored-By lines to any commit message
- NEVER include attribution footers in commits
- Write concise commit messages focused on the "what" and "why"

### Security
- NEVER commit secrets, API keys, credentials, or .env files
- NEVER hardcode tokens, passwords, or connection strings in source files
- Always use environment variables for sensitive configuration
- Validate all inputs at system boundaries
- Sanitize file paths to prevent directory traversal

### Memory & Learning
- Always persist learnings to pgvector on task completion
- Before starting a task, query pgvector for relevant past learnings
- Tag learnings with: role, task type, outcome (success/fail)
- Include failure context so future agents can avoid the same mistakes

### File Organization
- NEVER save files to the project root
- Use /src for source code
- Use /tests for test files
- Use /config for configuration
- Use /scripts for utility scripts
- Keep files under 500 lines
- Use typed interfaces for all public APIs

### Code Quality
- Write clean, readable, well-typed TypeScript
- Use native fetch (NEVER axios)
- Handle errors explicitly — no silent catches
- Follow single responsibility principle
- Prefer composition over inheritance
- Run tests after making code changes
- Verify build succeeds before committing

### Communication
- When you need input from another agent, use the CortexOS message bus
- Prefix messages with your role for clarity
- Be concise — other agents have context limits too
