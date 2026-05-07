# eevee Operator

> Kubernetes operator that manages BotModule and IpcConfig resources for the eevee chatbot ecosystem.

## Overview

This operator manages two custom resource types:

1. **BotModule** - Deploys and manages all eevee modules (connectors, plugins, router, toolbox)
2. **IpcConfig** - Manages NATS inter-process communication infrastructure

For each BotModule resource, the operator creates and maintains a Kubernetes Deployment, ConfigMap (for module configuration), and optional PersistentVolumeClaim. For each IpcConfig resource, the operator deploys and manages a NATS server with authentication.

## Install

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

2. Install the CRDs and operator:

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

| Variable | Default | Description |
|----------|---------|-------------|
| `NAMESPACE` | `eevee-bot` | The namespace the operator should watch |
| `WATCH_OTHER_NAMESPACES` | `false` | Watch resources in namespaces other than the operator's namespace |
| `KUBE_IN_CLUSTER_CONFIG` | `false` | Use in-cluster Kubernetes configuration |
| `HTTP_API_PORT` | `9000` | Port for the HTTP API server |
| `EEVEE_OPERATOR_API_TOKEN` | *(none)* | Bearer token for authenticated API endpoints |

## Helpful Commands

### Run build

```bash
npm run build
```

### Run dev build locally

```bash
npm run dev
```

## Contributing

Contributions are welcome! Please see the [eevee contributing guide](https://github.com/eeveebot/eevee) for details.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](./LICENSE) for the full text.
