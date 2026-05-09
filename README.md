# eevee Operator

> Kubernetes operator that manages BotModule, IpcConfig, S3Store, BackupSchedule, and BackupRestore resources for the eevee chatbot ecosystem.

## Overview

This operator manages five custom resource types:

1. **BotModule** - Deploys and manages all eevee modules (connectors, plugins, router, toolbox)
2. **IpcConfig** - Manages NATS inter-process communication infrastructure
3. **S3Store** - Validates and tracks S3-compatible storage connections for backups
4. **BackupSchedule** - Creates and manages CronJobs for scheduled PVC backups to S3
5. **BackupRestore** - Creates one-shot restore Jobs to recover PVC data from S3 backups

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

## How It Works

### Health Probes

The operator automatically sets default health probes on module pods:

- **Liveness probe:** HTTP GET `/health` on the module's `metricsPort`, with `initialDelaySeconds: 10` and `periodSeconds: 30`
- **Readiness probe:** HTTP GET `/health` on the module's `metricsPort`, with `initialDelaySeconds: 5` and `periodSeconds: 10`
- **Startup probe:** None (modules typically start quickly)

Modules use `setupHttpServer({ natsClients })` from `@eeveebot/libeevee` to wire the `/health` endpoint to NATS connectivity checks. When NATS is disconnected, `/health` returns 503, causing the readiness probe to fail and eventually triggering a liveness restart.

Custom probes can be specified via `livenessProbe`, `readinessProbe`, and `startupProbe` fields in the BotModule spec. These accept standard Kubernetes `V1Probe` objects and override the defaults entirely.

If a module has `metrics: false`, no default probes are set.

### S3 Backups

The operator supports scheduled backups of module PVCs to S3-compatible storage, and on-demand restores.

**Resources:**

- **S3Store** — defines an S3 connection (endpoint, bucket, credentials via secrets). The operator validates connectivity and surfaces the result in `status.lastConnectionTest`.
- **BackupSchedule** — ties an S3Store to a cron schedule and a botmodule. The operator creates and manages a CronJob that runs the backup image on schedule.
- **BackupRestore** — triggers a one-shot restore Job to recover a module's PVC from a specific backup (or the latest available).
- **BotModule** extensions — `spec.backupSchedule` references a backupschedule CR; `spec.bootstrapFromBackup` restores the latest backup before first deployment.

**S3 path format:** `<prefix>/<namespace>/<moduleName>/<uuid>.tar.gz`

**Backup image:** A separate container image (`ghcr.io/eeveebot/backup`) provides `backup.sh` and `restore.sh` scripts using `s3cmd`.

### BotModule Status Lifecycle

The operator tracks the module lifecycle via the `status` subresource. Every reconciliation overwrites status with the current truth — no stale snapshots.

| Reason | When |
|--------|------|
| `Pending` | Reconciliation starting |
| `WaitingForBackup` | `bootstrapFromBackup` set, no backups in S3 |
| `Bootstrapping` | Restore Job running |
| `BootstrapRestoreFailed` | Restore Job failed or timed out |
| `Disabled` | `spec.enabled: false` |
| `Creating` | Deployment just created |
| `Updating` | Deployment rolling out |
| `Ready` | Deployment healthy |
| `Unavailable` | Deployment degraded |

**Bootstrap annotation:** The operator tracks whether a PVC has been bootstrapped via the `eevee.bot/bootstrapped` annotation on the PVC itself (not the CR). This prevents stale restores over live data. The `backuprestore` CRD overrides the annotation — it always runs and sets the annotation on success.

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
