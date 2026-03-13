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

export const managedCrds: managedCrd[] = [
  {
    group: eevee.Router.details.group,
    version: eevee.Router.details.version,
    plural: eevee.Router.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received Router resource event:', event);

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `Router resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for added Router resource');
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added Router resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `Router resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for modified Router resource');
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified Router resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `Router resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Processing deletion of Router resource');
      // Delete the associated deployment when Router resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          const deploymentName = `eevee-${event.meta.name}-router`;
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
            `Failed to delete deployment eevee-${event.meta.name}-router in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for Router ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of Router resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting router reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to router reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    // Get the specific resource that changed
    const resourceName = event.meta.name;
    const resourceNamespace = event.meta.namespace;

    if (!resourceName || !resourceNamespace) {
      log.error('Resource name or namespace missing from event');
      return;
    }

    log.debug(
      `Processing Router resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the specific Router resource
    const routerResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.Router.details.group,
      version: eevee.Router.details.version,
      namespace: resourceNamespace,
      plural: eevee.Router.details.plural,
      name: resourceName,
    });

    // Validate that the response contains a body
    if (!routerResponse) {
      log.error(
        `Failed to retrieve Router resource ${resourceName} in namespace ${resourceNamespace}: Empty or invalid response`
      );
      return;
    }

    const item = routerResponse as eevee.Router.routerResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;

    if (!namespace || !name) {
      log.debug('Skipping Router resource with missing namespace or name');
      return;
    }

    // Generate deployment name based on router custom resource object name
    const deploymentName = `eevee-${name}-router`;
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
      await createRouterDeployment(appsV1Api, namespace, name, item);
    }

    // No service needed for router
    log.debug('No service required for router');
    log.debug('Router reconciliation completed successfully');
  } catch (error) {
    log.error('Error during router reconciliation:', error);
  }
}

async function createRouterDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  routerName: string,
  item: eevee.Router.routerResource
): Promise<void> {
  log.debug(
    `Creating Router deployment for ${routerName} in namespace ${namespace}`
  );

  // Generate deployment name based on router name
  const deploymentName = `eevee-${routerName}-router`;
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Get the image from the Router spec if available
  let routerImage = 'ghcr.io/eeveebot/router:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  let pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';
  let size = 1;

  log.debug('Processing Router spec for configuration');
  try {
    const routerConfig = item as eevee.Router.routerResource;
    if (routerConfig?.spec?.image) {
      routerImage = routerConfig.spec.image;
      log.debug(`Using custom image: ${routerImage}`);
    }
    if (routerConfig?.spec?.metrics !== undefined) {
      metricsEnabled = routerConfig.spec.metrics;
      log.debug(`Metrics enabled: ${metricsEnabled}`);
    }
    if (routerConfig?.spec?.metricsPort) {
      metricsPort = routerConfig.spec.metricsPort;
      log.debug(`Metrics port: ${metricsPort}`);
    }
    if (routerConfig?.spec?.size) {
      size = routerConfig.spec.size;
      log.debug(`Size: ${size}`);
    }
    if (routerConfig?.spec?.pullPolicy) {
      // Type assertion to ensure pullPolicy is a valid value
      pullPolicy = routerConfig.spec
        .pullPolicy as K8s.V1Container['imagePullPolicy'];
      log.debug(`Pull policy: ${pullPolicy}`);
    }
  } catch (error) {
    log.warn(`Failed to process Router ${routerName} for settings:`, error);
  }

  // Prepare environment variables for the router
  const containerEnvVars: K8s.V1EnvVar[] = [
    {
      name: 'NAMESPACE',
      valueFrom: {
        fieldRef: {
          fieldPath: 'metadata.namespace',
        },
      },
    },
    {
      name: 'RESOURCE_NAME',
      value: routerName,
    },
  ];

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

  // Prepare volumes and volume mounts
  const volumes: K8s.V1Volume[] = [];
  const volumeMounts: K8s.V1VolumeMount[] = [];

  // Handle moduleConfig if provided
  const moduleConfig = item.spec?.moduleConfig;
  if (moduleConfig) {
    try {
      const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
      const configMapName = `${deploymentName}-config`;
      const configMap: K8s.V1ConfigMap = {
        metadata: {
          name: configMapName,
          namespace: namespace,
        },
        data: {
          'config.yaml': JSON.stringify(moduleConfig, null, 2),
        },
      };

      try {
        await coreV1Api.createNamespacedConfigMap({
          namespace: namespace,
          body: configMap,
        });
        log.info(
          `Created ConfigMap ${configMapName} in namespace ${namespace}`
        );
      } catch (error) {
        log.warn(`Failed to create ConfigMap ${configMapName}:`, error);
      }

      // Add volume for config map
      volumes.push({
        name: 'module-config',
        configMap: {
          name: configMapName,
        },
      });

      // Add volume mount for config map
      volumeMounts.push({
        name: 'module-config',
        mountPath: '/etc/module-config',
      });

      // Add environment variable pointing to config
      containerEnvVars.push({
        name: 'MODULE_CONFIG_PATH',
        value: '/etc/module-config/config.yaml',
      });
    } catch (error) {
      log.warn('Failed to process moduleConfig:', error);
    }
  }

  log.debug('Creating deployment object');

  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: size,
      selector: {
        matchLabels: {
          'eevee.bot/router': 'true',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/router': 'true',
          },
        },
        spec: {
          volumes: volumes,
          containers: [
            {
              name: 'router',
              image: routerImage,
              imagePullPolicy: pullPolicy,
              env: containerEnvVars,
              ports: containerPorts,
              volumeMounts: volumeMounts,
            },
          ],
        },
      },
    },
  };

  log.debug(
    `Attempting to create Router deployment ${deploymentName} in namespace ${namespace}`
  );
  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created Router deployment ${deploymentName} in namespace ${namespace}` +
        `${metricsEnabled ? ` with metrics enabled on port ${metricsPort}` : ''}`
    );
    log.debug(`Router deployment creation completed for ${deploymentName}`);
  } catch (error) {
    log.error(
      `Failed to create Router deployment in namespace ${namespace}:`,
      error
    );
  }
}
