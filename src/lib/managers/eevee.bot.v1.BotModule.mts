'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';
import { parseBool } from '../../lib/functions.mjs';
import { k8sResourceEventsTotal } from '../../lib/metrics.mjs';

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

  // Track Kubernetes resource events
  k8sResourceEventsTotal.inc({
    resource_type: 'BotModule',
    event_type: event.type
  });

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

      // If bootstrapFromBackup is set and PVC exists, proactively mark it bootstrapped.
      // A running deployment with data means the PVC is already populated.
      if (item.spec?.bootstrapFromBackup && item.metadata?.name) {
        const pvcName = `eevee-${item.metadata.name}-data`;
        await ensurePvcBootstrappedAnnotation(coreV1Api, namespace, pvcName);
      }
    } catch {
      // Deployment doesn't exist, create it
      // If bootstrapFromBackup is set, run restore first
      if (item.spec?.bootstrapFromBackup) {
        const bootstrapped = await handleBootstrapFromBackup(
          customObjectsApi,
          namespace,
          name,
          item
        );
        if (!bootstrapped) {
          log.warn(
            `Bootstrap restore failed for BotModule "${name}" — skipping deployment creation`
          );
          return;
        }
      }

      log.info(
        `Creating deployment ${deploymentName} in namespace ${namespace}`
      );
      await createModuleDeployment(appsV1Api, coreV1Api, namespace, name, item);
    }

    // Validate backupSchedule reference if set
    if (item.spec?.backupSchedule) {
      await validateBackupScheduleRef(customObjectsApi, namespace, name, item);
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

  // Check if the module is enabled
  const isEnabled = item.spec?.enabled !== undefined ? item.spec.enabled : true;
  if (!isEnabled) {
    log.info(`BotModule "${moduleName}" is disabled, skipping deployment creation`);
    return;
  }

  // Generate deployment name based on botmodule name
  const deploymentName = `eevee-${moduleName}-module`;
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Get configuration from the BotModule spec
  let moduleImage = 'ghcr.io/eeveebot/module:latest';
  let metricsEnabled = false;
  let metricsPort = 9000;
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
      value: process.env.NAMESPACE || 'eevee-bot',
    },
    {
      name: 'RESOURCE_NAME',
      value: moduleName,
    },
  ];

  // Prepare envFrom for secret injection
  const containerEnvFrom: K8s.V1EnvFromSource[] = [];

  // Check if envSecret is provided and add it to envFrom
  if (item.spec?.envSecret) {
    log.debug(
      `Adding envSecret ${item.spec.envSecret.name} to module environment`
    );
    containerEnvFrom.push({
      secretRef: {
        name: item.spec.envSecret.name,
      },
    });
  }

  // Check if we should mount the operator API token
  if (item.spec?.mountOperatorApiToken) {
    const operatorApiToken = process.env.EEVEE_OPERATOR_API_TOKEN;
    if (operatorApiToken) {
      log.debug('Mounting operator API token to module environment');
      containerEnvVars.push({
        name: 'EEVEE_OPERATOR_API_TOKEN',
        value: operatorApiToken,
      });

      // Also set the operator API URL
      const operatorApiUrl = `http://eevee-eevee-operator-service.${namespace}.svc.cluster.local.:9000`;
      containerEnvVars.push({
        name: 'EEVEE_OPERATOR_API_URL',
        value: operatorApiUrl,
      });
    } else {
      log.warn(
        'mountOperatorApiToken is true but EEVEE_OPERATOR_API_TOKEN is not set in operator environment'
      );
    }
  }

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

    // Set HTTP_API_PORT to match metricsPort so the health and metrics
    // endpoints are served on the port that probes target
    containerEnvVars.push({
      name: 'HTTP_API_PORT',
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

    // Add MODULE_DATA environment variable pointing to the mounted PVC directory
    containerEnvVars.push({
      name: 'MODULE_DATA',
      value: volumeMountPath,
    });

    // Create the PVC
    try {
      // Ensure the PVC spec has the required resources.storage field
      const pvcSpec = item.spec.persistentVolumeClaim;
      if (pvcSpec && !pvcSpec.resources) {
        pvcSpec.resources = {
          requests: {
            storage: '1Gi', // Default storage size if not specified
          },
        };
      } else if (
        pvcSpec &&
        pvcSpec.resources &&
        !pvcSpec.resources.requests?.storage
      ) {
        // If resources exists but storage is not specified, add default
        pvcSpec.resources.requests = {
          ...pvcSpec.resources.requests,
          storage: '1Gi',
        };
      }

      await coreV1Api.createNamespacedPersistentVolumeClaim({
        namespace: namespace,
        body: {
          metadata: {
            name: `${deploymentName}-pvc`,
          },
          spec: pvcSpec,
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
          'config.yaml': moduleConfig,
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
              envFrom: containerEnvFrom,
              ports: containerPorts,
              volumeMounts: volumeMounts,
              livenessProbe: item.spec?.livenessProbe || {
                httpGet: { path: '/health', port: metricsPort || 9000 },
                initialDelaySeconds: 10,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              readinessProbe: item.spec?.readinessProbe || {
                httpGet: { path: '/health', port: metricsPort || 9000 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 3,
              },
              startupProbe: item.spec?.startupProbe,
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

  // Check if the module is enabled
  const isEnabled = item.spec?.enabled !== undefined ? item.spec.enabled : true;
  const deploymentName = `eevee-${moduleName}-module`;

  // If the module is disabled, delete the deployment if it exists
  if (!isEnabled) {
    try {
      log.info(`BotModule "${moduleName}" is disabled, deleting deployment if it exists`);
      await appsV1Api.deleteNamespacedDeployment({
        name: deploymentName,
        namespace: namespace,
      });
      log.info(`Deleted deployment ${deploymentName} for disabled BotModule "${moduleName}"`);
    } catch {
      // Ignore errors if deployment doesn't exist
      log.debug(`Deployment ${deploymentName} for disabled BotModule "${moduleName}" not found or already deleted`);
    }
    return;
  }

  // Get configuration from the BotModule spec
  let moduleImage = 'ghcr.io/eeveebot/module:latest';
  let metricsEnabled = false;
  let metricsPort = 9000;
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

    // Check if we should mount the operator API token
    if (item.spec?.mountOperatorApiToken) {
      const operatorApiToken = process.env.EEVEE_OPERATOR_API_TOKEN;
      if (operatorApiToken) {
        log.debug('Mounting operator API token to module environment');
        // Add the EEVEE_OPERATOR_API_TOKEN to container environment variables
        if (deployment?.spec?.template?.spec?.containers) {
          const container = deployment.spec.template.spec.containers[0];
          if (container) {
            // Check if the env var already exists
            const tokenEnvIndex = container.env?.findIndex(
              (env: K8s.V1EnvVar) => env.name === 'EEVEE_OPERATOR_API_TOKEN'
            );

            if (tokenEnvIndex === -1 || tokenEnvIndex === undefined) {
              // Add the token environment variable if it doesn't exist
              container.env = container.env || [];
              container.env.push({
                name: 'EEVEE_OPERATOR_API_TOKEN',
                value: operatorApiToken,
              });

              // Also set the operator API URL
              const operatorApiUrl = `http://eevee-eevee-operator-service.${namespace}.svc.cluster.local.:9000`;
              container.env.push({
                name: 'EEVEE_OPERATOR_API_URL',
                value: operatorApiUrl,
              });
            }
          }
        }
      } else {
        log.warn(
          'mountOperatorApiToken is true but EEVEE_OPERATOR_API_TOKEN is not set in operator environment'
        );
      }
    }

    // Handle envSecret in updates
    if (deployment?.spec?.template?.spec?.containers) {
      const container = deployment.spec.template.spec.containers[0];
      if (container) {
        // Initialize env and envFrom if they don't exist
        container.env = container.env || [];
        container.envFrom = container.envFrom || [];

        // Check if envSecret is provided
        if (item.spec?.envSecret) {
          log.debug(
            `Updating envSecret ${item.spec.envSecret.name} in module environment`
          );

          // Check if the secretRef already exists in envFrom
          const secretExists = container.envFrom.some(
            (envFrom: K8s.V1EnvFromSource) =>
              envFrom.secretRef?.name === item.spec?.envSecret?.name
          );

          // Add the secretRef if it doesn't exist
          if (!secretExists) {
            container.envFrom.push({
              secretRef: {
                name: item.spec.envSecret.name,
              },
            });
          }
        }

        // Ensure MODULE_DATA environment variable is set if PVC is used
        if (item.spec?.persistentVolumeClaim) {
          const hasModuleDataEnv = container.env.some(
            (env: K8s.V1EnvVar) => env.name === 'MODULE_DATA'
          );

          if (!hasModuleDataEnv) {
            // Determine the volume mount path
            let volumeMountPath = '/data';
            if (item.spec?.volumeMountPath) {
              volumeMountPath = item.spec.volumeMountPath;
            }

            container.env.push({
              name: 'MODULE_DATA',
              value: volumeMountPath,
            });
            log.debug(
              `Added MODULE_DATA environment variable with value: ${volumeMountPath}`
            );
          }
        }
      }
    }

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

          // Set HTTP_API_PORT to match metricsPort so the health and metrics
          // endpoints are served on the port that probes target
          const hasHttpApiPort = container.env?.some(
            (env: K8s.V1EnvVar) => env.name === 'HTTP_API_PORT'
          );
          if (!hasHttpApiPort) {
            container.env = container.env || [];
            container.env.push({
              name: 'HTTP_API_PORT',
              value: metricsPort.toString(),
            });
          } else {
            const httpApiPortEnv = container.env?.find(
              (env: K8s.V1EnvVar) => env.name === 'HTTP_API_PORT'
            );
            if (httpApiPortEnv) {
              httpApiPortEnv.value = metricsPort.toString();
            }
          }
        } else {
          // Remove metrics port if present
          if (container.ports) {
            container.ports = container.ports.filter(
              (port) => port.name !== 'metrics'
            );
          }
        }

        // Update probes
        container.livenessProbe = item.spec?.livenessProbe || {
          httpGet: { path: '/health', port: metricsPort || 9000 },
          initialDelaySeconds: 10,
          periodSeconds: 30,
          timeoutSeconds: 5,
          failureThreshold: 3,
        };
        container.readinessProbe = item.spec?.readinessProbe || {
          httpGet: { path: '/health', port: metricsPort || 9000 },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 3,
          failureThreshold: 3,
        };
        container.startupProbe = item.spec?.startupProbe;
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
          'config.yaml': moduleConfig,
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

/**
 * Validate that the backupSchedule reference exists.
 * This is a lightweight check — the BackupSchedule manager owns the CronJob.
 */
async function validateBackupScheduleRef(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.botmoduleResource
): Promise<void> {
  const scheduleName = item.spec?.backupSchedule?.name;
  if (!scheduleName) {
    return;
  }

  try {
    await customObjectsApi.getNamespacedCustomObject({
      group: eevee.BackupSchedule.details.group,
      version: eevee.BackupSchedule.details.version,
      namespace: namespace,
      plural: eevee.BackupSchedule.details.plural,
      name: scheduleName,
    });
    log.debug(
      `BackupSchedule "${scheduleName}" reference validated for BotModule "${moduleName}"`
    );
  } catch (error) {
    log.warn(
      `BackupSchedule "${scheduleName}" referenced by BotModule "${moduleName}" not found in namespace ${namespace}`
    );
  }
}

/**
 * Handle bootstrapFromBackup: restore the latest backup from S3 before
 * creating the deployment for the first time.
 *
 * Returns true if bootstrapped (or already bootstrapped), false on failure.
 * The operator tracks bootstrapped state via an annotation on the botmodule CR.
 */
async function handleBootstrapFromBackup(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.botmoduleResource
): Promise<boolean> {
  const bootstrapConfig = item.spec?.bootstrapFromBackup;
  if (!bootstrapConfig) {
    return true;
  }

  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);

  // Check if PVC is already bootstrapped via annotation
  const pvcName = `eevee-${item.metadata?.name}-data`;
  const isBootstrapped = await checkPvcBootstrappedAnnotation(
    coreV1Api,
    namespace,
    pvcName
  );
  if (isBootstrapped) {
    log.debug(
      `PVC ${pvcName} is already bootstrapped — skipping restore for BotModule "${moduleName}"`
    );
    return true;
  }

  const s3StoreName = bootstrapConfig.s3Store?.name;
  const restoreImage = bootstrapConfig.image;

  if (!s3StoreName || !restoreImage) {
    log.warn(
      `BotModule "${moduleName}" has incomplete bootstrapFromBackup config (missing s3Store name or image)`
    );
    return false;
  }

  // Resolve the s3store
  let s3StoreSpec: eevee.S3Store.s3storeSpec | undefined;
  try {
    const s3StoreResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.S3Store.details.group,
      version: eevee.S3Store.details.version,
      namespace: namespace,
      plural: eevee.S3Store.details.plural,
      name: s3StoreName,
    });
    const s3StoreItem = s3StoreResponse as eevee.S3Store.s3storeResource;
    s3StoreSpec = s3StoreItem.spec;
  } catch (error) {
    log.warn(
      `Failed to resolve s3store "${s3StoreName}" for bootstrap restore of BotModule "${moduleName}":`,
      error
    );
    return false;
  }

  if (!s3StoreSpec) {
    log.warn(`s3store "${s3StoreName}" has no spec`);
    return false;
  }

  // Find the latest backup via S3 listing
  const accessId = await resolveBootstrapSecretKey(
    coreV1Api,
    namespace,
    s3StoreSpec.accessId?.secretKeyRef?.secret?.name!,
    s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace || namespace,
    s3StoreSpec.accessId?.secretKeyRef?.key!
  );
  const secretKey = await resolveBootstrapSecretKey(
    coreV1Api,
    namespace,
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.name!,
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace || namespace,
    s3StoreSpec.accessKey?.secretKeyRef?.key!
  );

  if (!accessId || !secretKey) {
    log.warn(
      `Cannot resolve S3 credentials for bootstrap restore of BotModule "${moduleName}"`
    );
    return false;
  }

  const botModuleName = item.spec?.moduleName || moduleName;
  const backupId = await findLatestBackupForModule(
    s3StoreSpec.endpoint,
    accessId,
    secretKey,
    s3StoreSpec.bucket,
    s3StoreSpec.prefix || '',
    namespace,
    botModuleName,
    s3StoreSpec.pathStyle || false
  );

  if (!backupId) {
    log.warn(
      `No backups found for module "${botModuleName}" in s3store "${s3StoreName}" — cannot bootstrap`
    );
    return false;
  }

  // Create a one-shot restore Job
  const batchV1Api = kc.makeApiClient(K8s.BatchV1Api);
  const jobName = `eevee-${moduleName}-bootstrap-restore`;
  const volumeMountPath = item.spec?.volumeMountPath || '/data';

  const envVars: K8s.V1EnvVar[] = [
    { name: 'S3_ENDPOINT', value: s3StoreSpec.endpoint },
    { name: 'S3_BUCKET', value: s3StoreSpec.bucket },
    { name: 'S3_PREFIX', value: s3StoreSpec.prefix || '' },
    { name: 'S3_PATH_STYLE', value: String(s3StoreSpec.pathStyle || false) },
    { name: 'RESTORE_NAMESPACE', value: namespace },
    { name: 'RESTORE_MODULE', value: botModuleName },
    { name: 'RESTORE_BACKUP_ID', value: backupId },
    { name: 'BACKUP_PVC_PATH', value: volumeMountPath },
  ];

  // Add S3 credentials from Secrets
  if (s3StoreSpec.accessId?.secretKeyRef?.secret?.name && s3StoreSpec.accessId.secretKeyRef.key) {
    envVars.push({
      name: 'S3_ACCESS_ID',
      valueFrom: {
        secretKeyRef: {
          name: s3StoreSpec.accessId.secretKeyRef.secret.name,
          key: s3StoreSpec.accessId.secretKeyRef.key,
        },
      },
    });
  }

  if (s3StoreSpec.accessKey?.secretKeyRef?.secret?.name && s3StoreSpec.accessKey.secretKeyRef.key) {
    envVars.push({
      name: 'S3_SECRET_KEY',
      valueFrom: {
        secretKeyRef: {
          name: s3StoreSpec.accessKey.secretKeyRef.secret.name,
          key: s3StoreSpec.accessKey.secretKeyRef.key,
        },
      },
    });
  }

  const volumes: K8s.V1Volume[] = [
    {
      name: 'module-data',
      persistentVolumeClaim: { claimName: pvcName },
    },
  ];
  const volumeMounts: K8s.V1VolumeMount[] = [
    {
      name: 'module-data',
      mountPath: volumeMountPath,
    },
  ];

  const job: K8s.V1Job = {
    metadata: {
      name: jobName,
      namespace: namespace,
    },
    spec: {
      template: {
        spec: {
          restartPolicy: 'OnFailure',
          volumes: volumes,
          containers: [
            {
              name: 'restore',
              image: restoreImage,
              command: ['/usr/local/bin/restore.sh'],
              env: envVars,
              volumeMounts: volumeMounts,
            },
          ],
        },
      },
    },
  };

  try {
    log.info(
      `Creating bootstrap restore Job ${jobName} for BotModule "${moduleName}" (backup: ${backupId})`
    );
    await batchV1Api.createNamespacedJob({ namespace: namespace, body: job });
  } catch (error) {
    log.warn(
      `Failed to create bootstrap restore Job for BotModule "${moduleName}":`,
      error
    );
    return false;
  }

  // Wait for the Job to complete (poll with timeout)
  const maxWaitMs = 300000; // 5 minutes
  const pollIntervalMs = 5000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const jobStatus = await batchV1Api.readNamespacedJob({
        name: jobName,
        namespace: namespace,
      });

      if (jobStatus.status?.succeeded) {
        log.info(
          `Bootstrap restore Job succeeded for BotModule "${moduleName}"`
        );

        // Set the bootstrapped annotation on the PVC
        await ensurePvcBootstrappedAnnotation(
          coreV1Api,
          namespace,
          pvcName,
        );

        // Clean up the Job
        try {
          await batchV1Api.deleteNamespacedJob({
            name: jobName,
            namespace: namespace,
          });
        } catch {
          // Best effort
        }

        return true;
      }

      if (jobStatus.status?.failed) {
        log.warn(
          `Bootstrap restore Job failed for BotModule "${moduleName}"`
        );
        return false;
      }
    } catch (error) {
      log.warn('Error checking bootstrap restore Job status:', error);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  log.warn(
    `Bootstrap restore Job timed out for BotModule "${moduleName}" after ${maxWaitMs / 1000}s`
  );
  return false;
}

/**
 * Resolve a secret key value from a Kubernetes Secret reference.
 */
async function resolveBootstrapSecretKey(
  coreV1Api: K8s.CoreV1Api,
  fallbackNamespace: string,
  secretName: string,
  secretNamespace: string,
  key: string
): Promise<string | undefined> {
  try {
    const response = await coreV1Api.readNamespacedSecret({
      name: secretName,
      namespace: secretNamespace || fallbackNamespace,
    });
    const data = response.data;
    if (data && data[key]) {
      return Buffer.from(data[key], 'base64').toString('utf-8');
    }
    return undefined;
  } catch (error) {
    log.warn(`Failed to read Secret "${secretName}":`, error);
    return undefined;
  }
}

/**
 * Find the latest backup UUID for a module by listing S3 objects
 * and selecting the most recent by LastModified timestamp.
 */
async function findLatestBackupForModule(
  endpoint: string,
  accessId: string,
  secretKey: string,
  bucket: string,
  prefix: string,
  namespace: string,
  moduleName: string,
  pathStyle: boolean
): Promise<string | undefined> {
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      endpoint: endpoint,
      credentials: {
        accessKeyId: accessId,
        secretAccessKey: secretKey,
      },
      forcePathStyle: pathStyle,
      region: 'us-east-1',
    });

    const s3Prefix = `${prefix}${namespace}/${moduleName}/`;
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: s3Prefix,
    });

    const response = await client.send(command);
    const objects = response.Contents;

    if (!objects || objects.length === 0) {
      return undefined;
    }

    const sorted = objects
      .filter((obj) => obj.Key?.endsWith('.tar.gz'))
      .sort((a, b) => {
        const aTime = a.LastModified?.getTime() || 0;
        const bTime = b.LastModified?.getTime() || 0;
        return bTime - aTime;
      });

    if (sorted.length === 0) {
      return undefined;
    }

    const latestKey = sorted[0].Key;
    if (!latestKey) {
      return undefined;
    }

    const parts = latestKey.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace('.tar.gz', '');
  } catch (error) {
    log.warn('Failed to list S3 objects for bootstrap:', error);
    return undefined;
  }
}

/**
 * Check if a PVC has the eevee.bot/bootstrapped annotation set to "true".
 */
async function checkPvcBootstrappedAnnotation(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  pvcName: string,
): Promise<boolean> {
  try {
    const pvc = await coreV1Api.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: namespace,
    });
    const annotations = pvc.metadata?.annotations || {};
    return annotations['eevee.bot/bootstrapped'] === 'true';
  } catch (error) {
    // PVC doesn't exist yet — not bootstrapped
    log.debug(`PVC ${pvcName} not found when checking bootstrapped annotation`);
    return false;
  }
}

/**
 * Set the eevee.bot/bootstrapped annotation on a PVC.
 * If the PVC doesn't exist, silently skip (it will be created by the
 * deployment and annotated on the next reconciliation).
 */
async function ensurePvcBootstrappedAnnotation(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  pvcName: string,
): Promise<void> {
  try {
    const pvc = await coreV1Api.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: namespace,
    });

    // Already annotated
    if (pvc.metadata?.annotations?.['eevee.bot/bootstrapped'] === 'true') {
      return;
    }

    pvc.metadata = pvc.metadata || {};
    pvc.metadata.annotations = pvc.metadata.annotations || {};
    pvc.metadata.annotations['eevee.bot/bootstrapped'] = 'true';

    await coreV1Api.replaceNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: namespace,
      body: pvc,
    });
    log.debug(`Set bootstrapped annotation on PVC ${pvcName}`);
  } catch (error) {
    log.debug(
      `Could not set bootstrapped annotation on PVC ${pvcName} (may not exist yet):`,
      error
    );
  }
}
