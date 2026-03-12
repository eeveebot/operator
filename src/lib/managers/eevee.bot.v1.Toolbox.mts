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
    group: eevee.Toolbox.details.group,
    version: eevee.Toolbox.details.version,
    plural: eevee.Toolbox.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(
    'Received Toolbox resource event:',
    event.type,
    event.meta.name,
    event.meta.namespace
  );

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `Toolbox resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
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
        `Toolbox resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
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
        `Toolbox resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // Delete the associated deployment when Toolbox resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          await appsV1Api.deleteNamespacedDeployment({
            name: `eevee-toolbox-${event.meta.name}`,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted deployment eevee-toolbox-${event.meta.name} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete deployment eevee-toolbox-${event.meta.name} in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for Toolbox ${event.meta.name} - no namespace specified`
        );
      }
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(kc?: K8s.KubeConfig): Promise<void> {
  if (!kc) {
    log.error('KubeConfig not provided to toolbox reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    // List all Toolbox custom resources
    const toolboxList = await customObjectsApi.listCustomObjectForAllNamespaces(
      {
        group: eevee.Toolbox.details.group,
        version: eevee.Toolbox.details.version,
        plural: eevee.Toolbox.details.plural,
      }
    );

    // For each Toolbox resource, ensure a deployment exists in its namespace
    if (toolboxList.body?.items) {
      for (const item of toolboxList.body.items) {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) continue;

        // Generate deployment name based on toolbox custom resource object name
        const deploymentName = `eevee-toolbox-${name}`;

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
          // Pass the ipcConfig name if specified in the Toolbox spec
          const ipcConfigName = item.spec?.ipcConfig;
          await createToolboxDeployment(
            appsV1Api,
            namespace,
            name,
            item,
            ipcConfigName
          );
        }
      }
    }
  } catch (error) {
    log.error('Error during toolbox reconciliation:', error);
  }
}

async function createToolboxDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  toolboxName: string,
  item: eevee.Toolbox.toolboxResource,
  ipcConfigName?: string
): Promise<void> {
  // If ipcConfigName is provided, try to fetch the IPC config to get NATS settings
  const natsEnvVars: K8s.V1EnvVar[] = [];
  if (ipcConfigName) {
    try {
      const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
      const ipcConfigResponse =
        await customObjectsApi.getNamespacedCustomObject({
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
        const secretName = natsTokenConfig.secretKeyRef.secret.name;

        // Add NATS_HOST from the same secret (assuming it's in a field called 'host')
        natsEnvVars.push({
          name: 'NATS_HOST',
          valueFrom: {
            secretKeyRef: {
              name: secretName,
              key: 'host',
            },
          },
        });

        // Add NATS_TOKEN from the secret reference
        natsEnvVars.push({
          name: 'NATS_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: secretName,
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
  }

  // Generate deployment name based on toolbox name
  const deploymentName = `eevee-toolbox-${toolboxName}`;

  // Get the image from the Toolbox spec if available
  let toolboxImage = 'ghcr.io/eeveebot/cli:latest';
  try {
    const toolbox = item as eevee.Toolbox.toolboxResource;
    if (toolbox?.spec?.image) {
      toolboxImage = toolbox.spec.image;
    }
  } catch (error) {
    log.warn(
      `Failed to process Toolbox ${toolboxName} for image settings:`,
      error
    );
  }

  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'eevee-toolbox',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee-toolbox',
          },
        },
        spec: {
          containers: [
            {
              name: 'toolbox',
              image: toolboxImage,
              imagePullPolicy: 'Always',
              env: natsEnvVars,
            },
          ],
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
          },
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
      `Successfully created deployment eevee-toolbox in namespace ${namespace}`
    );
  } catch (error) {
    log.error(`Failed to create deployment in namespace ${namespace}:`, error);
  }
}
