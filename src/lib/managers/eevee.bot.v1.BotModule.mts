'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';
import { dump as yamlDump } from 'js-yaml';

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
    group: eevee.BotModule.details.group,
    version: eevee.BotModule.details.version,
    plural: eevee.BotModule.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received BotModule resource event:', event);

  // Extract module name for logging
  const moduleName =
    (event.object as eevee.BotModule.botmoduleResource)?.spec?.moduleName ||
    event.meta.name;

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `BotModule "${moduleName}" resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for added BotModule resource');
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added BotModule resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `BotModule "${moduleName}" resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for modified BotModule resource');
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified BotModule resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `BotModule "${moduleName}" resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Processing deletion of BotModule resource');
      // Delete the associated deployment when BotModule resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          const deploymentName = `eevee-${event.meta.name}-module`;
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
            `Failed to delete deployment eevee-${event.meta.name}-module in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for BotModule ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of BotModule resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  // Extract module name for logging
  const moduleName =
    (event.object as eevee.BotModule.botmoduleResource)?.spec?.moduleName ||
    event.meta.name;
  log.debug(
    `Starting botmodule "${moduleName}" reconciliation for specific resource`
  );
  if (!kc) {
    log.error('KubeConfig not provided to botmodule reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
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
      `Processing BotModule "${moduleName}" resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the specific BotModule resource
    const botModuleResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.BotModule.details.group,
      version: eevee.BotModule.details.version,
      namespace: resourceNamespace,
      plural: eevee.BotModule.details.plural,
      name: resourceName,
    });

    // Validate that the response contains a body
    if (!botModuleResponse) {
      log.error(
        `Failed to retrieve BotModule resource ${resourceName} in namespace ${resourceNamespace}: Empty or invalid response`
      );
      return;
    }

    const item = botModuleResponse as eevee.BotModule.botmoduleResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;

    if (!namespace || !name) {
      log.debug('Skipping BotModule resource with missing namespace or name');
      return;
    }

    // Generate deployment name based on botmodule custom resource object name
    const deploymentName = `eevee-${name}-module`;
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

      // Update the deployment if it exists
      await updateModuleDeployment(appsV1Api, namespace, name, item);
    } catch {
      // Deployment doesn't exist, create it
      log.info(
        `Creating deployment ${deploymentName} in namespace ${namespace}`
      );
      await createModuleDeployment(appsV1Api, coreV1Api, namespace, name, item);
    }

    log.debug('BotModule reconciliation completed successfully');
  } catch (error) {
    log.error('Error during botmodule reconciliation:', error);
  }
}

async function createModuleDeployment(
  appsV1Api: K8s.AppsV1Api,
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.botmoduleResource
): Promise<void> {
  log.debug(
    `Creating module deployment for "${moduleName}" in namespace ${namespace}`
  );

  // Generate deployment name based on botmodule name
  const deploymentName = `eevee-${moduleName}-module`;
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Get configuration from the BotModule spec
  let moduleImage = 'ghcr.io/eeveebot/module:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  let size = 1;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';
  let volumeMountPath = '/data';

  log.debug('Processing BotModule spec for configuration');
  try {
    const moduleConfig = item as eevee.BotModule.botmoduleResource;
    if (moduleConfig?.spec?.image) {
      moduleImage = moduleConfig.spec.image;
      log.debug(`Using custom image: ${moduleImage}`);
    }
    if (moduleConfig?.spec?.metrics !== undefined) {
      metricsEnabled = moduleConfig.spec.metrics;
      log.debug(`Metrics enabled: ${metricsEnabled}`);
    }
    if (moduleConfig?.spec?.metricsPort) {
      metricsPort = moduleConfig.spec.metricsPort;
      log.debug(`Metrics port: ${metricsPort}`);
    }
    if (moduleConfig?.spec?.size) {
      size = moduleConfig.spec.size;
      log.debug(`Replica count: ${size}`);
    }
    if (moduleConfig?.spec?.volumeMountPath) {
      volumeMountPath = moduleConfig.spec.volumeMountPath;
      log.debug(`Volume mount path: ${volumeMountPath}`);
    }
  } catch (error) {
    log.warn(
      `Failed to process BotModule "${moduleName}" for settings:`,
      error
    );
  }

  // Prepare environment variables for the module
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
      value: moduleName,
    },
  ];

  // If ipcConfigName is provided, try to fetch the IPC config to get NATS settings
  const ipcConfigName = item.spec?.ipcConfig;
  if (ipcConfigName && ipcConfigName.length > 0) {
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

      const ipcConfig = ipcConfigResponse as IpcConfigResponse;
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

  // Prepare volumes and volume mounts
  const volumes: K8s.V1Volume[] = [];
  const volumeMounts: K8s.V1VolumeMount[] = [];

  // Add PVC if specified in the spec
  if (item.spec?.persistentVolumeClaim) {
    volumes.push({
      name: 'module-data',
      persistentVolumeClaim: {
        claimName: `${deploymentName}-pvc`,
      },
    });

    volumeMounts.push({
      name: 'module-data',
      mountPath: volumeMountPath,
    });

    // Create the PVC
    try {
      await coreV1Api.createNamespacedPersistentVolumeClaim({
        namespace: namespace,
        body: {
          metadata: {
            name: `${deploymentName}-pvc`,
          },
          spec: item.spec.persistentVolumeClaim,
        },
      });
      log.info(`Created PVC ${deploymentName}-pvc in namespace ${namespace}`);
    } catch (error) {
      log.warn(`Failed to create PVC ${deploymentName}-pvc:`, error);
    }
  }

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
          'config.yaml': yamlDump(moduleConfig, { indent: 2 }),
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
      } catch (error: unknown) {
        if (
          (error as { response?: { statusCode?: number } }).response
            ?.statusCode === 409
        ) {
          // ConfigMap already exists, update it
          try {
            await coreV1Api.replaceNamespacedConfigMap({
              name: configMapName,
              namespace: namespace,
              body: configMap,
            });
            log.info(
              `Updated ConfigMap ${configMapName} in namespace ${namespace}`
            );
          } catch (updateError) {
            log.warn(
              `Failed to update ConfigMap ${configMapName}:`,
              updateError
            );
          }
        } else {
          log.warn(`Failed to create ConfigMap ${configMapName}:`, error);
        }
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

  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: size,
      selector: {
        matchLabels: {
          'eevee.bot/module': moduleName,
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/module': moduleName,
          },
        },
        spec: {
          volumes: volumes,
          containers: [
            {
              name: 'module',
              image: moduleImage,
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
    `Attempting to create module deployment ${deploymentName} in namespace ${namespace}`
  );
  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created module deployment ${deploymentName} in namespace ${namespace}` +
        `${metricsEnabled ? ` with metrics enabled on port ${metricsPort}` : ''}`
    );
    log.debug(`Module deployment creation completed for ${deploymentName}`);
  } catch (error) {
    log.error(
      `Failed to create module deployment in namespace ${namespace}:`,
      error
    );
  }
}

async function updateModuleDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.botmoduleResource
): Promise<void> {
  log.debug(
    `Updating module deployment for "${moduleName}" in namespace ${namespace}`
  );

  // Generate deployment name based on botmodule name
  const deploymentName = `eevee-${moduleName}-module`;

  // Get configuration from the BotModule spec
  let moduleImage = 'ghcr.io/eeveebot/module:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  let size = 1;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';
  let volumeMountPath = '/data';

  log.debug('Processing BotModule spec for configuration');
  try {
    const moduleConfig = item as eevee.BotModule.botmoduleResource;
    if (moduleConfig?.spec?.image) {
      moduleImage = moduleConfig.spec.image;
      log.debug(`Using custom image: ${moduleImage}`);
    }
    if (moduleConfig?.spec?.metrics !== undefined) {
      metricsEnabled = moduleConfig.spec.metrics;
      log.debug(`Metrics enabled: ${metricsEnabled}`);
    }
    if (moduleConfig?.spec?.metricsPort) {
      metricsPort = moduleConfig.spec.metricsPort;
      log.debug(`Metrics port: ${metricsPort}`);
    }
    if (moduleConfig?.spec?.size) {
      size = moduleConfig.spec.size;
      log.debug(`Replica count: ${size}`);
    }
    if (moduleConfig?.spec?.volumeMountPath) {
      volumeMountPath = moduleConfig.spec.volumeMountPath;
      log.debug(`Volume mount path: ${volumeMountPath}`);
    }
  } catch (error) {
    log.warn(
      `Failed to process BotModule "${moduleName}" for settings:`,
      error
    );
  }

  try {
    // Get the current deployment
    const deploymentResponse = await appsV1Api.readNamespacedDeployment({
      name: deploymentName,
      namespace: namespace,
    });

    const deployment = deploymentResponse as K8s.V1Deployment;

    // Update the deployment properties
    if (
      deployment &&
      deployment.spec &&
      deployment.spec.template.spec &&
      deployment.spec.template.spec.containers
    ) {
      deployment.spec.replicas = size;

      const container = deployment.spec.template.spec.containers[0];
      if (container) {
        container.image = moduleImage;
        container.imagePullPolicy = pullPolicy;

        // Update ports if metrics settings changed
        if (metricsEnabled) {
          // Add metrics port if not present
          const hasMetricsPort = container.ports?.some(
            (port) => port.name === 'metrics'
          );
          if (!hasMetricsPort) {
            container.ports = container.ports || [];
            container.ports.push({
              name: 'metrics',
              containerPort: metricsPort,
              protocol: 'TCP',
            });
          }
        } else {
          // Remove metrics port if present
          if (container.ports) {
            container.ports = container.ports.filter(
              (port) => port.name !== 'metrics'
            );
          }
        }
      }

      // Update the deployment
      await appsV1Api.replaceNamespacedDeployment({
        name: deploymentName,
        namespace: namespace,
        body: deployment,
      });

      log.info(
        `Updated deployment ${deploymentName} in namespace ${namespace}`
      );
    }
  } catch (error) {
    log.error(`Failed to update deployment ${deploymentName}:`, error);
  }

  // Handle moduleConfig updates if provided
  const moduleConfig = item.spec?.moduleConfig;
  try {
    const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
    const configMapName = `${deploymentName}-config`;

    if (moduleConfig) {
      // Update or create the ConfigMap with the new configuration
      const configMap: K8s.V1ConfigMap = {
        metadata: {
          name: configMapName,
          namespace: namespace,
        },
        data: {
          'config.yaml': yamlDump(moduleConfig, { indent: 2 }),
        },
      };

      try {
        await coreV1Api.replaceNamespacedConfigMap({
          name: configMapName,
          namespace: namespace,
          body: configMap,
        });
        log.info(
          `Updated ConfigMap ${configMapName} in namespace ${namespace}`
        );
      } catch (error: unknown) {
        if (
          (error as { response?: { statusCode?: number } }).response
            ?.statusCode === 404
        ) {
          // ConfigMap doesn't exist, create it
          try {
            await coreV1Api.createNamespacedConfigMap({
              namespace: namespace,
              body: configMap,
            });
            log.info(
              `Created ConfigMap ${configMapName} in namespace ${namespace}`
            );
          } catch (createError) {
            log.warn(
              `Failed to create ConfigMap ${configMapName}:`,
              createError
            );
          }
        } else {
          log.warn(`Failed to update ConfigMap ${configMapName}:`, error);
        }
      }
    } else {
      // If moduleConfig is not provided, delete the ConfigMap if it exists
      try {
        await coreV1Api.deleteNamespacedConfigMap({
          name: configMapName,
          namespace: namespace,
        });
        log.info(
          `Deleted ConfigMap ${configMapName} in namespace ${namespace}`
        );
      } catch (error: unknown) {
        if (
          (error as { response?: { statusCode?: number } }).response
            ?.statusCode !== 404
        ) {
          log.warn(`Failed to delete ConfigMap ${configMapName}:`, error);
        }
      }
    }
  } catch (error) {
    log.warn('Failed to process moduleConfig update:', error);
  }
}
