# eevee Operator

hello operator, can you give me number nine

## Overview

This operator manages three custom resource types:

1. **ChatConnectionIrc** - Manages IRC chat connections
2. **IpcConfig** - Manages inter-process communication configurations
3. **Toolbox** - Manages toolbox configurations

For each custom resource created in the cluster, the operator creates and maintains the necessary Kubernetes deployments to run the corresponding eevee components.

## Installation

The eevee Operator is installed using Helm. The chart is hosted in our custom repository.

### Prerequisites

- Helm 3.0+
- Kubernetes cluster with access to add Helm repositories

### Installation Steps

1. Add the eevee Helm repository:

   ```bash
   helm repo add eevee https://helm.eevee.bot
   helm repo update
   ```

2. Install the crds and operator:

   ```bash
   helm install eevee-crds eevee/crds --namespace eevee-bot
   helm install eevee-operator eevee/operator --namespace eevee-bot
   ```

### Configuration

The operator can be configured using Helm values. See the chart documentation at [helm.eevee.bot](https://helm.eevee.bot/) for available options.

## Development

### Building

```bash
npm run build
```

This command will:

1. Run ESLint to check for code issues
2. Compile TypeScript files

### Development Mode

```bash
npm run dev
```

This command will:

1. Build the project
2. Run the operator locally

### Updating Dependencies

```bash
npm run update-libraries
```

Updates the core eevee libraries to their latest versions.

## Environment Variables

The operator supports the following environment variables:

- `NAMESPACE` - The namespace the operator should watch (default: "eevee-bot")
- `WATCH_OTHER_NAMESPACES` - Whether to watch resources in namespaces other than the operator's namespace (default: "false")

## Helpful Commands

### Run build

```bash
npm run build
```

### Run dev build locally

```bash
npm run dev
```

## License

This project is licensed under the Attribution-NonCommercial-ShareAlike 4.0 International License.
