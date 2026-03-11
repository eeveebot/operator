'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';

// Create KubeConfig for this manager
const kc = new K8s.KubeConfig();
kc.loadFromDefault();

export const managedCrds: managedCrd[] = [
  {
    group: eevee.IpcConfig.details.group,
    version: eevee.IpcConfig.details.version,
    plural: eevee.IpcConfig.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(
    'Received IpcConfig resource event:',
    event.type,
    event.meta.name,
    event.meta.namespace
  );

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `IpcConfig resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc);
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `IpcConfig resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc);
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `IpcConfig resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // Delete the associated deployment when IpcConfig resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          await appsV1Api.deleteNamespacedDeployment({
            name: `eevee-nats-${event.meta.name}`,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted deployment eevee-nats-${event.meta.name} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete deployment eevee-nats-${event.meta.name} in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for IpcConfig ${event.meta.name} - no namespace specified`
        );
      }
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(kc?: K8s.KubeConfig): Promise<void> {
  if (!kc) {
    log.error('KubeConfig not provided to ipcconfig reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    // List all IpcConfig custom resources
    const ipcConfigList =
      await customObjectsApi.listCustomObjectForAllNamespaces({
        group: eevee.IpcConfig.details.group,
        version: eevee.IpcConfig.details.version,
        plural: eevee.IpcConfig.details.plural,
      });

    // For each IpcConfig resource, ensure a deployment exists in its namespace
    if (ipcConfigList.body?.items) {
      for (const item of ipcConfigList.body.items) {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) continue;

        // Generate deployment name based on ipcconfig custom resource object name
        const deploymentName = `eevee-nats-${name}`;

        // Check if deployment exists
        try {
          await appsV1Api.readNamespacedDeployment({
            name: deploymentName,
            namespace: namespace,
          });
          log.debug(
            `Deployment ${deploymentName} already exists in namespace ${namespace}`
          );
        } catch {
          // Deployment doesn't exist, create it
          log.info(
            `Creating deployment ${deploymentName} in namespace ${namespace}`
          );
          await createNatsDeployment(appsV1Api, namespace, name);
        }
      }
    }
  } catch (error) {
    log.error('Error during ipcconfig reconciliation:', error);
  }
}

async function createNatsDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ipcConfigName: string
): Promise<void> {
  // Try to fetch the IPC config to get NATS token settings
  const natsEnvVars: K8s.V1EnvVar[] = [];
  let natsTokenSecretName: string | undefined;

  try {
    const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
    const ipcConfigResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.IpcConfig.details.group,
      version: eevee.IpcConfig.details.version,
      namespace: namespace,
      plural: eevee.IpcConfig.details.plural,
      name: ipcConfigName,
    });

    // Define type for IPC config response
    interface IpcConfigResponse {
      spec?: {
        nats?: {
          token?: {
            secretKeyRef?: {
              secret: {
                name: string;
              };
              key: string;
            };
          };
        };
      };
    }

    const ipcConfig = ipcConfigResponse.body as IpcConfigResponse;
    const natsTokenConfig = ipcConfig?.spec?.nats?.token;

    if (natsTokenConfig?.secretKeyRef) {
      natsTokenSecretName = natsTokenConfig.secretKeyRef.secret.name;

      // Add NATS token to environment variables
      natsEnvVars.push({
        name: 'NATS_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: natsTokenSecretName,
            key: 'token',
          },
        },
      });
    }
  } catch (error) {
    log.warn(
      `Failed to fetch IPC config ${ipcConfigName} for NATS settings:`,
      error
    );
  }

  // Generate deployment name based on ipcconfig name
  const deploymentName = `eevee-nats-${ipcConfigName}`;

  // Prepare command arguments for NATS server with auth
  const commandArgs = ['--auth', '$NATS_TOKEN'];

  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'eevee-nats',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee-nats',
          },
        },
        spec: {
          containers: [
            {
              name: 'nats',
              image: 'docker.io/nats:latest',
              imagePullPolicy: 'Always',
              command: ['nats-server'],
              args: commandArgs,
              ports: [
                {
                  containerPort: 4222,
                  name: 'client',
                },
                {
                  containerPort: 8222,
                  name: 'management',
                },
                {
                  containerPort: 6222,
                  name: 'cluster',
                },
              ],
              env: natsEnvVars,
            },
          ],
        },
      },
    },
  };

  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created NATS deployment ${deploymentName} in namespace ${namespace}`
    );
  } catch (error) {
    log.error(
      `Failed to create NATS deployment in namespace ${namespace}:`,
      error
    );
  }
}
