'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';
import { parseBool } from '../../lib/functions.mjs';

// Create KubeConfig for this manager
const kc = new K8s.KubeConfig();
const KUBE_IN_CLUSTER_CONFIG = parseBool(process.env.KUBE_IN_CLUSTER_CONFIG);
if (KUBE_IN_CLUSTER_CONFIG) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}

// Get namespace configuration
const NAMESPACE = process.env.NAMESPACE || 'eevee-bot';
const WATCH_OTHER_NAMESPACES_ENV =
  process.env.WATCH_OTHER_NAMESPACES || 'false';
const WATCH_OTHER_NAMESPACES = parseBool(WATCH_OTHER_NAMESPACES_ENV);

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
      log.debug('Triggering reconciliation for added Toolbox resource');
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc);
        log.debug('Reconciliation completed for added Toolbox resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `Toolbox resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for modified Toolbox resource');
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc);
        log.debug('Reconciliation completed for modified Toolbox resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `Toolbox resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Processing deletion of Toolbox resource');
      // Delete the associated deployment when Toolbox resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          const deploymentName = `eevee-${event.meta.name}-toolbox`;
          log.debug(
            `Attempting to delete deployment ${deploymentName} in namespace ${event.meta.namespace}`
          );
          await appsV1Api.deleteNamespacedDeployment({
            name: deploymentName,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted deployment ${deploymentName} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete deployment eevee-${event.meta.name}-toolbox in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for Toolbox ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of Toolbox resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(kc?: K8s.KubeConfig): Promise<void> {
  log.debug('Starting toolbox reconciliation');
  if (!kc) {
    log.error('KubeConfig not provided to toolbox reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    let toolboxList: { body?: { items?: eevee.Toolbox.toolboxResource[] } };

    if (WATCH_OTHER_NAMESPACES) {
      log.debug('Listing all Toolbox custom resources');
      // List all Toolbox custom resources
      toolboxList = await customObjectsApi.listCustomObjectForAllNamespaces({
        group: eevee.Toolbox.details.group,
        version: eevee.Toolbox.details.version,
        plural: eevee.Toolbox.details.plural,
      });
      log.debug('Successfully listed Toolbox resources across all namespaces');
    } else {
      log.debug(`Listing Toolbox custom resources in namespace ${NAMESPACE}`);
      // List Toolbox custom resources only in the specified namespace
      toolboxList = await customObjectsApi.listNamespacedCustomObject({
        group: eevee.Toolbox.details.group,
        version: eevee.Toolbox.details.version,
        namespace: NAMESPACE,
        plural: eevee.Toolbox.details.plural,
      });
      log.debug(
        `Successfully listed Toolbox resources in namespace ${NAMESPACE}`,
        toolboxList,
      );
    }

    // For each Toolbox resource, ensure a deployment exists in its namespace
    if (toolboxList.body?.items) {
      log.debug(
        `Processing ${toolboxList.body.items.length} Toolbox resources`
      );
      for (const item of toolboxList.body.items) {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) {
          log.debug('Skipping Toolbox resource with missing namespace or name');
          continue;
        }
        log.debug(
          `Processing Toolbox resource ${name} in namespace ${namespace}`
        );

        // Generate deployment name based on toolbox custom resource object name
        const deploymentName = `eevee-${name}-toolbox`;
        log.debug(
          `Checking for deployment ${deploymentName} in namespace ${namespace}`
        );

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
          log.debug(
            `IPC config name from Toolbox spec: ${ipcConfigName || 'none'}`
          );
          await createToolboxDeployment(
            appsV1Api,
            namespace,
            name,
            item,
            ipcConfigName
          );
        }
      }
      log.debug('Finished processing all Toolbox resources');
    }
    log.debug('Toolbox reconciliation completed successfully');
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
  log.debug(
    `Creating Toolbox deployment for ${toolboxName} in namespace ${namespace}`,
    {
      ipcConfigName: ipcConfigName || 'none',
    }
  );

  // If ipcConfigName is provided, try to fetch the IPC config to get NATS settings
  const containerEnvVars: K8s.V1EnvVar[] = [];
  if (ipcConfigName) {
    log.debug(`Fetching IPC config ${ipcConfigName} for NATS settings`);
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
        log.debug(`Found NATS token secret reference: ${secretName}`);

        // Add NATS_HOST from the same secret (assuming it's in a field called 'host')
        containerEnvVars.push({
          name: 'NATS_HOST',
          valueFrom: {
            secretKeyRef: {
              name: secretName,
              key: 'host',
            },
          },
        });

        // Add NATS_TOKEN from the secret reference
        containerEnvVars.push({
          name: 'NATS_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: secretName,
              key: 'token',
            },
          },
        });
      } else {
        log.debug('No NATS token configuration found in IPC config');
      }
    } catch (error) {
      log.warn(
        `Failed to fetch IPC config ${ipcConfigName} for NATS settings:`,
        error
      );
    }
  } else {
    log.debug('No IPC config name provided, skipping NATS configuration');
  }

  // Generate deployment name based on toolbox name
  const deploymentName = `eevee-${toolboxName}-toolbox`;
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Get the image from the Toolbox spec if available
  let toolboxImage = 'ghcr.io/eeveebot/cli:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  let pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';

  log.debug('Processing Toolbox spec for configuration');
  try {
    const toolbox = item as eevee.Toolbox.toolboxResource;
    if (toolbox?.spec?.image) {
      toolboxImage = toolbox.spec.image;
      log.debug(`Using custom image: ${toolboxImage}`);
    }
    if (toolbox?.spec?.metrics !== undefined) {
      metricsEnabled = toolbox.spec.metrics;
      log.debug(`Metrics enabled: ${metricsEnabled}`);
    }
    if (toolbox?.spec?.metricsPort) {
      metricsPort = toolbox.spec.metricsPort;
      log.debug(`Metrics port: ${metricsPort}`);
    }
    if (toolbox?.spec?.pullPolicy) {
      pullPolicy = toolbox.spec
        .pullPolicy as K8s.V1Container['imagePullPolicy'];
      log.debug(`Image pull policy: ${pullPolicy}`);
    }
  } catch (error) {
    log.warn(`Failed to process Toolbox ${toolboxName} for settings:`, error);
  }

  // Prepare container ports
  const containerPorts: K8s.V1ContainerPort[] = [];

  // Add metrics port if metrics are enabled
  if (metricsEnabled) {
    log.debug('Adding metrics port to container configuration');
    containerPorts.push({
      name: 'metrics',
      containerPort: metricsPort,
      protocol: 'TCP',
    });

    // Add metrics environment variable
    containerEnvVars.push({
      name: 'METRICS_ENABLED',
      value: 'true',
    });

    containerEnvVars.push({
      name: 'METRICS_PORT',
      value: metricsPort.toString(),
    });
  }

  log.debug('Creating deployment object');
  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'eevee.bot/toolbox': 'true',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/toolbox': 'true',
          },
        },
        spec: {
          containers: [
            {
              name: 'eevee-toolbox',
              image: toolboxImage,
              imagePullPolicy: pullPolicy,
              env: containerEnvVars,
              ports: containerPorts,
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

  log.debug(
    `Attempting to create deployment ${deploymentName} in namespace ${namespace}`
  );
  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created deployment ${deploymentName} in namespace ${namespace}` +
        `${metricsEnabled ? ` with metrics enabled on port ${metricsPort}` : ''}`
    );
    log.debug(`Deployment creation completed for ${deploymentName}`);
  } catch (error) {
    log.error(`Failed to create deployment in namespace ${namespace}:`, error);
  }
}
