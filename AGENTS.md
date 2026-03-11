# Agent Development Guide

This guide provides essential information for agentic coding agents working with this repository.

## Build/Lint/Test Commands

### Build Commands

```bash
# Build the project (runs lint first, then compiles TypeScript)
npm run build

# Development mode (builds and runs the application)
npm run dev
```

### Lint Commands

```bash
# Run ESLint to check for code issues
npm run test

# Run Prettier to check formatting
npx prettier --check src/

# Run both linting and formatting checks
npm run test && npx prettier --check src/
```

### Test Commands

```bash
# Run ESLint (currently the only test command)
npm run test
```

### Running Individual Tests

Since the project currently only uses ESLint for testing, you can run ESLint on individual files:

```bash
# Run ESLint on a specific file
npx eslint src/main.mts

# Run ESLint on a specific directory
npx eslint src/lib/
```

Note: The project currently uses ESLint for linting rather than traditional unit testing.

## Code Style Guidelines

### Language and Extensions

- Primary language: TypeScript
- File extensions: `.mts` for TypeScript modules, `.mjs` for JavaScript modules
- Module system: ES Modules (ESM)
- Target: ES2024

### Imports

- Use ES module import syntax (`import`)
- Group imports logically:
  1. External packages
  2. Internal libraries/dependencies
  3. Local modules
- Add blank lines between groups
- Use explicit file extensions when importing local files

Example:

```typescript
import * as K8s from '@kubernetes/client-node';
import { default as Operator } from '@thehonker/k8s-operator';

import { eeveeLogo } from './lib/logo.mjs';
import { log } from './lib/logging.mjs';
```

### Formatting

- Indentation: 2 spaces (no tabs)
- Line endings: LF (Unix-style)
- Max line length: No strict limit, but aim for readability
- Trailing commas: Enabled for ES5+
- Semicolons: Required
- Quotes: Single quotes preferred

Prettier configuration:

```yaml
trailingComma: 'es5'
tabWidth: 2
semi: true
singleQuote: true
```

### Types

- Strict TypeScript mode enabled
- Explicit typing preferred over inference when clarity is needed
- Use TypeScript interfaces for object shapes
- Use TypeScript types for unions, primitives, and aliases

### Naming Conventions

- Variables: camelCase
- Functions: camelCase
- Classes/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE
- Files: kebab-case or dot.case for namespaced files (e.g., eevee.bot.v1.ChatConnectionIrc.mts)
- Private members: prefixed with underscore (\_privateMethod)

### Error Handling

- Use async/await with try/catch for asynchronous operations
- Handle errors appropriately - log and/or propagate
- Use the built-in logger (`log`) for logging messages
- Include meaningful error messages with context

### Additional Guidelines

- Use `'use strict';` at the top of each file
- Follow the existing code organization patterns with commented sections
- Use JSDoc-style comments for function documentation
- Prefer functional programming patterns over object-oriented when possible
- Use Winston for logging via the imported `log` object

## Debugging and Development Workflow

### Debugging

- Use `console.log` sparingly and remove debug statements before committing
- Use the built-in logger (`log`) for debugging output
- Set `LOG_LEVEL` environment variable to control verbosity (e.g., `LOG_LEVEL=debug`)

## Kubernetes Operator Guidelines

### Custom Resource Definitions

- Custom resources are managed through CRD handlers
- Each CRD has a corresponding manager file in `src/lib/managers/`
- Handlers should be asynchronous and handle ResourceEvents properly
- Use the provided `log` object for consistent logging in handlers

### Resource Event Handling

- Implement `handleResourceEvent` functions for each managed CRD
- Events contain the full resource object and event type (ADDED, MODIFIED, DELETED)
- Always validate resource objects before processing
- Handle errors gracefully to prevent operator crashes

### Kubernetes Client Usage

- Use the provided Kubernetes client from `@kubernetes/client-node`
- Access through the `kc` (KubeConfig) instance in main.mts
- Create API clients using `kc.makeApiClient()` method
- Always handle API errors appropriately with try/catch blocks

### Operator Lifecycle

- The operator watches for changes to registered CRDs
- Handlers are called asynchronously when resources change
- Clean shutdown is handled through signal handlers (SIGTERM, SIGINT)
- Ensure proper cleanup in the `exit()` function for graceful termination
