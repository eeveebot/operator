'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

import { log } from '../../lib/logging.mjs';
import { resolveSecretKey, findLatestBackup, validateSecretNamespace } from '../../lib/functions.mjs';
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
  const spec = (event.object as eevee.BotModule.BotModuleResource)?.spec;
  const moduleName = spec?.moduleName || event.meta.name;

  // Validate spec.moduleName is explicitly set
  if (!spec?.moduleName) {
    log.error(`BotModule "${event.meta.name}" is missing required spec.moduleName`);
    const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
    await updateBotModuleStatus(customObjectsApi, event.meta.namespace || '', event.meta.name, {
      conditions: [{
        type: 'Ready',
        status: 'False',
        reason: 'InvalidSpec',
        message: 'spec.moduleName is required',
        lastTransitionTime: new Date().toISOString(),
      }],
    }, true);
    return;
  }

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

      // Trigger reconciliation of BackupSchedules that were targeting this botmodule.
      // Since the botmodule CR is deleted, we can't read its spec. Instead,
      // find CronJobs matching the naming pattern (<schedule>-<botmodule>-backup)
      // and trace to their owning schedule via ownerReferences.
      if (event.meta.namespace) {
        try {
          const batchV1Api = kc.makeApiClient(K8s.BatchV1Api);
          const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
          const cronJobsResponse = await batchV1Api.listNamespacedCronJob({
            namespace: event.meta.namespace,
          });
          const cronJobs = cronJobsResponse.items || [];
          const scheduleNamesToTrigger = new Set<string>();

          for (const cj of cronJobs) {
            const cjName = cj.metadata?.name || '';
            // CronJob names follow: <schedule-name>-<botmodule-cr-name>-backup
            if (cjName.endsWith(`-${event.meta.name}-backup`)) {
              // Find the owning BackupSchedule via ownerReferences
              const ownerRef = cj.metadata?.ownerReferences?.[0];
              if (ownerRef) {
                scheduleNamesToTrigger.add(ownerRef.name);
              }
            }
          }

          for (const scheduleName of scheduleNamesToTrigger) {
            try {
              await customObjectsApi.patchNamespacedCustomObject({
                group: eevee.BackupSchedule.details.group,
                version: eevee.BackupSchedule.details.version,
                namespace: event.meta.namespace,
                plural: eevee.BackupSchedule.details.plural,
                name: scheduleName,
                body: {
                  metadata: {
                    annotations: {
                      'eevee.bot/reconcile-requested': new Date().toISOString(),
                    },
                  },
                },
              });
              log.debug(
                `Triggered reconciliation of BackupSchedule "${scheduleName}" after BotModule deletion`
              );
            } catch (error) {
              log.warn(
                `Failed to trigger reconciliation of BackupSchedule "${scheduleName}":`,
                error
              );
            }
          }
        } catch (error) {
          log.warn('Failed to find CronJobs for deletion trigger:', error);
        }
      }
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  // Extract module name for logging
  const spec = (event.object as eevee.BotModule.BotModuleResource)?.spec;
  const moduleName = spec?.moduleName || event.meta.name;
  log.debug(
    `Starting botmodule "${moduleName}" reconciliation for specific resource`
  );

  // Validate spec.moduleName is explicitly set
  if (!spec?.moduleName) {
    log.error(`BotModule "${event.meta.name}" is missing required spec.moduleName`);
    const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
    await updateBotModuleStatus(customObjectsApi, event.meta.namespace || '', event.meta.name, {
      conditions: [{
        type: 'Ready',
        status: 'False',
        reason: 'InvalidSpec',
        message: 'spec.moduleName is required',
        lastTransitionTime: new Date().toISOString(),
      }],
    }, true);
    return;
  }
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

    const item = botModuleResponse as eevee.BotModule.BotModuleResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;

    if (!namespace || !name) {
      log.debug('Skipping BotModule resource with missing namespace or name');
      return;
    }

    // Set initial status during reconciliation
    await updateBotModuleStatus(customObjectsApi, namespace, name, {
      conditions: [{
        type: 'Ready',
        status: 'Unknown',
        reason: 'Reconciling',
        message: 'Reconciling',
        lastTransitionTime: new Date().toISOString(),
      }],
    });

    // Generate deployment name based on botmodule custom resource object name
    const deploymentName = `eevee-${name}-module`;
    const pvcName = `${deploymentName}-pvc`;
    log.debug(
      `Checking for deployment ${deploymentName} in namespace ${namespace}`
    );

    // Ensure PVC exists before anything else (deployment, bootstrap restore, etc.)
    if (item.spec?.persistentVolumeClaim) {
      await ensurePvc(coreV1Api, namespace, pvcName, item.spec.persistentVolumeClaim, item.spec?.backupSchedule?.name);
    }

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
      await updateModuleDeployment(appsV1Api, customObjectsApi, namespace, name, item);

      // Check deployment health and set status accordingly
      await updateBotModuleStatusFromDeployment(
        appsV1Api,
        customObjectsApi,
        namespace,
        name,
        deploymentName
      );

      // If bootstrapFromBackup is set and PVC exists, proactively mark it bootstrapped.
      // A running deployment with data means the PVC is already populated.
      if (item.spec?.bootstrapFromBackup) {
        await ensurePvcBootstrappedAnnotation(coreV1Api, namespace, pvcName);
      }
    } catch {
      // Deployment doesn't exist, create it
      // If bootstrapFromBackup is set, run restore first
      if (item.spec?.bootstrapFromBackup) {
        const bootstrapped = await handleBootstrapFromBackup(
          customObjectsApi,
          coreV1Api,
          namespace,
          name,
          pvcName,
          item
        );
        if (!bootstrapped) {
          log.warn(
            `Bootstrap restore failed for BotModule "${name}" — skipping deployment creation`
          );
          // Status is already set by handleBootstrapFromBackup
          // (WaitingForBackup or BootstrapRestoreFailed)
          return;
        }
      }

      log.info(
        `Creating deployment ${deploymentName} in namespace ${namespace}`
      );
      await createModuleDeployment(appsV1Api, coreV1Api, customObjectsApi, namespace, name, item);

      // Set status to Creating — deployment was just created, may not be ready yet
      await updateBotModuleStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'Unknown',
          reason: 'Creating',
          message: 'Deployment created',
          lastTransitionTime: new Date().toISOString(),
        }],
      });
    }

    // Validate backupSchedule reference if set
    if (item.spec?.backupSchedule) {
      await validateAndTriggerBackupScheduleReconcile(customObjectsApi, namespace, name, item);
    }

    log.debug('BotModule reconciliation completed successfully');
  } catch (error) {
    log.error('Error during botmodule reconciliation:', error);
  }
}

async function createModuleDeployment(
  appsV1Api: K8s.AppsV1Api,
  coreV1Api: K8s.CoreV1Api,
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.BotModuleResource
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
  let moduleImage: string | undefined;
  let metricsEnabled = false;
  let metricsPort = 9000;
  let size = 1;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] =
    (item as eevee.BotModule.BotModuleResource)?.spec?.imagePullPolicy as K8s.V1Container['imagePullPolicy']
    || (item as eevee.BotModule.BotModuleResource)?.spec?.pullPolicy as K8s.V1Container['imagePullPolicy']
    || 'IfNotPresent';
  let volumeMountPath = '/data';

  log.debug('Processing BotModule spec for configuration');
  try {
    const moduleConfig = item as eevee.BotModule.BotModuleResource;
    if (moduleConfig?.spec?.image) {
      moduleImage = moduleConfig.spec.image;
      log.debug(`Using image: ${moduleImage}`);
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

  if (!moduleImage) {
    log.error(`BotModule "${moduleName}" is missing required spec.image`);
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Ready',
        status: 'False',
        reason: 'InvalidSpec',
        message: 'spec.image is required',
        lastTransitionTime: new Date().toISOString(),
      }],
    }, true);
    return;
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
    validateSecretNamespace(
      item.spec.envSecret.name!,
      item.spec.envSecret.namespace as string | undefined,
      namespace,
      `BotModule "${moduleName}" envSecret`
    );
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
        validateSecretNamespace(
          secretName,
          (natsTokenConfig.secretKeyRef.secret as { namespace?: string }).namespace,
          namespace,
          `BotModule "${moduleName}" NATS token`
        );
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
    // PVC is now created in the reconciler before this function is called
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
          // ConfigMap already exists, patch it
          try {
            await coreV1Api.patchNamespacedConfigMap({
              name: configMapName,
              namespace: namespace,
              body: {
                data: configMap.data,
              },
            });
            log.info(
              `Patched ConfigMap ${configMapName} in namespace ${namespace}`
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
              resources: item.spec?.resources,
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
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.BotModuleResource
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
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Ready',
        status: 'False',
        reason: 'Disabled',
        message: 'Module is disabled',
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    return;
  }

  // Get configuration from the BotModule spec
  let moduleImage: string | undefined;
  let metricsEnabled = false;
  let metricsPort = 9000;
  let size = 1;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] =
    (item as eevee.BotModule.BotModuleResource)?.spec?.imagePullPolicy as K8s.V1Container['imagePullPolicy']
    || (item as eevee.BotModule.BotModuleResource)?.spec?.pullPolicy as K8s.V1Container['imagePullPolicy']
    || 'IfNotPresent';
  let volumeMountPath = '/data';

  log.debug('Processing BotModule spec for configuration');
  try {
    const moduleConfig = item as eevee.BotModule.BotModuleResource;
    if (moduleConfig?.spec?.image) {
      moduleImage = moduleConfig.spec.image;
      log.debug(`Using image: ${moduleImage}`);
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

  if (!moduleImage) {
    log.error(`BotModule "${moduleName}" is missing required spec.image`);
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Ready',
        status: 'False',
        reason: 'InvalidSpec',
        message: 'spec.image is required',
        lastTransitionTime: new Date().toISOString(),
      }],
    }, true);
    return;
  }

  try {
    // Get the current deployment
    const deploymentResponse = await appsV1Api.readNamespacedDeployment({
      name: deploymentName,
      namespace: namespace,
    });

    const deployment = deploymentResponse as K8s.V1Deployment;

    // Build the desired container spec for patching
    const desiredContainer: K8s.V1Container = {
      name: 'module',
      image: moduleImage,
      imagePullPolicy: pullPolicy,
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
    };

    if (item.spec?.resources) {
      desiredContainer.resources = item.spec.resources;
    }

    // Handle metrics port
    if (metricsEnabled) {
      desiredContainer.ports = deployment?.spec?.template?.spec?.containers?.[0]?.ports || [];
      const hasMetricsPort = desiredContainer.ports.some(
        (port) => port.name === 'metrics'
      );
      if (!hasMetricsPort) {
        desiredContainer.ports.push({
          name: 'metrics',
          containerPort: metricsPort,
          protocol: 'TCP',
        });
      }
    } else {
      const existingPorts = deployment?.spec?.template?.spec?.containers?.[0]?.ports;
      if (existingPorts) {
        desiredContainer.ports = existingPorts.filter(
          (port) => port.name !== 'metrics'
        );
      }
    }

    // Build env updates
    const desiredEnv: K8s.V1EnvVar[] = [];
    // HTTP_API_PORT for metrics
    if (metricsEnabled) {
      desiredEnv.push({ name: 'HTTP_API_PORT', value: metricsPort.toString() });
    }
    // Operator API token
    if (item.spec?.mountOperatorApiToken) {
      const operatorApiToken = process.env.EEVEE_OPERATOR_API_TOKEN;
      if (operatorApiToken) {
        desiredEnv.push({ name: 'EEVEE_OPERATOR_API_TOKEN', value: operatorApiToken });
        desiredEnv.push({
          name: 'EEVEE_OPERATOR_API_URL',
          value: `http://eevee-eevee-operator-service.${namespace}.svc.cluster.local.:9000`,
        });
      }
    }
    // MODULE_DATA for PVC
    if (item.spec?.persistentVolumeClaim) {
      desiredEnv.push({ name: 'MODULE_DATA', value: volumeMountPath });
    }
    // Merge with existing env vars, overriding duplicates
    const existingEnv = deployment?.spec?.template?.spec?.containers?.[0]?.env || [];
    const envMap = new Map<string, K8s.V1EnvVar>();
    for (const e of existingEnv) { envMap.set(e.name, e); }
    for (const e of desiredEnv) { envMap.set(e.name, e); }
    desiredContainer.env = Array.from(envMap.values());

    // Build envFrom for envSecret
    const desiredEnvFrom: K8s.V1EnvFromSource[] =
      deployment?.spec?.template?.spec?.containers?.[0]?.envFrom || [];
    if (item.spec?.envSecret) {
      const secretExists = desiredEnvFrom.some(
        (envFrom) => envFrom.secretRef?.name === item.spec?.envSecret?.name
      );
      if (!secretExists) {
        desiredEnvFrom.push({ secretRef: { name: item.spec.envSecret.name } });
      }
    }
    desiredContainer.envFrom = desiredEnvFrom;

    // Patch the deployment
    await appsV1Api.patchNamespacedDeployment({
      name: deploymentName,
      namespace: namespace,
      body: {
        spec: {
          replicas: size,
          template: {
            spec: {
              containers: [desiredContainer],
            },
          },
        },
      },
    });

    log.info(
      `Patched deployment ${deploymentName} in namespace ${namespace}`
    );
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
        await coreV1Api.patchNamespacedConfigMap({
          name: configMapName,
          namespace: namespace,
          body: {
            data: configMap.data,
          },
        });
        log.info(
          `Patched ConfigMap ${configMapName} in namespace ${namespace}`
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
 * Validate the backupSchedule reference and trigger reconciliation
 * of the referenced BackupSchedule by patching its annotations.
 */
async function validateAndTriggerBackupScheduleReconcile(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  moduleName: string,
  item: eevee.BotModule.BotModuleResource
): Promise<void> {
  const scheduleName = item.spec?.backupSchedule?.name;

  // Set or clear the backup-schedule label on the botmodule
  const currentLabel = item.metadata?.labels?.['eevee.bot/backup-schedule'];
  const desiredLabel = scheduleName || null;
  if (currentLabel !== desiredLabel) {
    try {
      await customObjectsApi.patchNamespacedCustomObject({
        group: eevee.BotModule.details.group,
        version: eevee.BotModule.details.version,
        namespace: namespace,
        plural: eevee.BotModule.details.plural,
        name: moduleName,
        body: {
          metadata: {
            labels: scheduleName
              ? { 'eevee.bot/backup-schedule': scheduleName }
              : { 'eevee.bot/backup-schedule': null },
          },
        },
      });
    } catch (error) {
      log.debug('Failed to update backup-schedule label on botmodule:', error);
    }
  }

  if (!scheduleName) {
    return;
  }

  try {
    // Verify the schedule exists
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

    // Trigger reconciliation by setting the reconcile-requested annotation
    await customObjectsApi.patchNamespacedCustomObject({
      group: eevee.BackupSchedule.details.group,
      version: eevee.BackupSchedule.details.version,
      namespace: namespace,
      plural: eevee.BackupSchedule.details.plural,
      name: scheduleName,
      body: {
        metadata: {
          annotations: {
            'eevee.bot/reconcile-requested': new Date().toISOString(),
          },
        },
      },
    });
    log.debug(
      `Triggered reconciliation of BackupSchedule "${scheduleName}" via annotation`
    );
  } catch {
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
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  moduleName: string,
  pvcName: string,
  item: eevee.BotModule.BotModuleResource
): Promise<boolean> {
  const bootstrapConfig = item.spec?.bootstrapFromBackup;
  if (!bootstrapConfig) {
    return true;
  }

  // Check if PVC is already bootstrapped via annotation
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
  const restoreImage = bootstrapConfig.image || 'ghcr.io/eeveebot/backupJob:latest';

  if (!s3StoreName) {
    log.warn(
      `BotModule "${moduleName}" has incomplete bootstrapFromBackup config (missing s3Store name)`
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'BootstrapConfigInvalid',
        message: 'Incomplete bootstrapFromBackup config (missing s3Store name)',
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    return false;
  }

  // Resolve the s3store
  let s3StoreSpec: eevee.S3Store.S3StoreSpec | undefined;
  try {
    const s3StoreResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.S3Store.details.group,
      version: eevee.S3Store.details.version,
      namespace: namespace,
      plural: eevee.S3Store.details.plural,
      name: s3StoreName,
    });
    const s3StoreItem = s3StoreResponse as eevee.S3Store.S3StoreResource;
    s3StoreSpec = s3StoreItem.spec;

    // Check that the S3Store is Ready (connection test passed)
    const s3StoreConditions = (s3StoreItem.status as unknown as { conditions?: { type: string; status: string; reason: string; message?: string }[] })?.conditions;
    const s3Ready = s3StoreConditions?.find(c => c.type === 'Ready');
    if (!s3Ready || s3Ready.status !== 'True') {
      const reason = s3Ready?.reason || 'S3StoreNotReady';
      const msg = s3Ready?.message || `S3Store "${s3StoreName}" is not ready`;
      log.warn(`S3Store "${s3StoreName}" is not ready (${reason}) for bootstrap restore of BotModule "${moduleName}"`);
      await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
        conditions: [{
          type: 'Bootstrapped',
          status: 'False',
          reason: 'S3StoreNotReady',
          message: msg,
          lastTransitionTime: new Date().toISOString(),
        }],
      });
      return false;
    }
  } catch (error) {
    log.warn(
      `Failed to resolve s3store "${s3StoreName}" for bootstrap restore of BotModule "${moduleName}":`,
      error
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'S3StoreNotFound',
        message: `Failed to resolve s3store "${s3StoreName}"`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    return false;
  }

  if (!s3StoreSpec) {
    log.warn(`s3store "${s3StoreName}" has no spec`);
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'S3StoreInvalid',
        message: `s3store "${s3StoreName}" has no spec`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    return false;
  }

  // Find the latest backup via S3 listing
  validateSecretNamespace(
    s3StoreSpec.accessId?.secretKeyRef?.secret?.name,
    s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace,
    namespace,
    `BotModule "${moduleName}" bootstrap accessId`
  );
  const accessId = await resolveSecretKey(
    coreV1Api,
    namespace,
    s3StoreSpec.accessId?.secretKeyRef?.secret?.name,
    s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace || namespace,
    s3StoreSpec.accessId?.secretKeyRef?.key
  );
  validateSecretNamespace(
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.name,
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace,
    namespace,
    `BotModule "${moduleName}" bootstrap accessKey`
  );
  const secretKey = await resolveSecretKey(
    coreV1Api,
    namespace,
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.name,
    s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace || namespace,
    s3StoreSpec.accessKey?.secretKeyRef?.key
  );

  if (!accessId || !secretKey) {
    log.warn(
      `Cannot resolve S3 credentials for bootstrap restore of BotModule "${moduleName}"`
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'SecretNotFound',
        message: 'Failed to resolve S3 credentials from Secrets',
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    return false;
  }

  const botModuleName = item.spec?.moduleName || moduleName;
  const backupId = await findLatestBackup(
    s3StoreSpec.endpoint,
    accessId,
    secretKey,
    s3StoreSpec.bucket,
    s3StoreSpec.prefix || '',
    namespace,
    botModuleName,
    s3StoreSpec.pathStyle || false,
    s3StoreSpec.region
  );

  if (!backupId) {
    log.warn(
      `No backups found for module "${botModuleName}" in s3store "${s3StoreName}" — cannot bootstrap`
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'WaitingForBackup',
        message: `Waiting for backup: no backups found for module "${botModuleName}" in s3store "${s3StoreName}"`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });
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
    { name: 'S3_SIGNATURE_V2', value: String(s3StoreSpec.signatureV2 || false) },
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
      ownerReferences: [
        {
          apiVersion: `${eevee.BotModule.details.group}/${eevee.BotModule.details.version}`,
          kind: eevee.BotModule.details.name,
          name: moduleName,
          uid: item.metadata?.uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      template: {
        spec: {
          restartPolicy: 'OnFailure',
          activeDeadlineSeconds: 600,
          volumes: volumes,
          containers: [
            {
              name: 'restore',
              image: restoreImage,
              imagePullPolicy: bootstrapConfig?.imagePullPolicy as K8s.V1Container['imagePullPolicy'] || 'IfNotPresent',
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
    // Check if a bootstrap restore Job already exists
    try {
      const existingJob = await batchV1Api.readNamespacedJob({
        name: jobName,
        namespace: namespace,
      });

      if (existingJob.status?.succeeded) {
        log.info(
          `Bootstrap restore Job already succeeded for BotModule "${moduleName}"`
        );
        await ensurePvcBootstrappedAnnotation(coreV1Api, namespace, pvcName);

        // Clean up the Job
        try {
          await batchV1Api.deleteNamespacedJob({ name: jobName, namespace: namespace });
        } catch {
          // Best effort
        }
        return true;
      }

      if (existingJob.status?.failed) {
        log.warn(
          `Bootstrap restore Job already failed for BotModule "${moduleName}" — not retrying, Job left for inspection`
        );
        await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
          conditions: [{
            type: 'Bootstrapped',
            status: 'False',
            reason: 'BootstrapRestoreFailed',
            message: 'Bootstrap restore Job failed (Job retained for inspection)',
            lastTransitionTime: new Date().toISOString(),
          }],
        });
        return false;
      }

      // Job is still running — fall through to wait loop
      log.debug(
        `Bootstrap restore Job "${jobName}" still running — waiting for completion`
      );
    } catch {
      // Job doesn't exist yet — create it below
    }

    log.info(
      `Creating bootstrap restore Job ${jobName} for BotModule "${moduleName}" (backup: ${backupId})`
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'Unknown',
        reason: 'Bootstrapping',
        message: `Restoring from backup ${backupId}`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });
    await batchV1Api.createNamespacedJob({ namespace: namespace, body: job });
  } catch (error) {
    log.warn(
      `Failed to create bootstrap restore Job for BotModule "${moduleName}":`,
      error
    );
    await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
      conditions: [{
        type: 'Bootstrapped',
        status: 'False',
        reason: 'BootstrapRestoreFailed',
        message: `Failed to create bootstrap restore Job: ${error}`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });
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
        await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
          conditions: [{
            type: 'Bootstrapped',
            status: 'False',
            reason: 'BootstrapRestoreFailed',
            message: 'Bootstrap restore Job failed',
            lastTransitionTime: new Date().toISOString(),
          }],
        });
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
  await updateBotModuleStatus(customObjectsApi, namespace, moduleName, {
    conditions: [{
      type: 'Bootstrapped',
      status: 'False',
      reason: 'BootstrapRestoreFailed',
      message: `Bootstrap restore Job timed out after ${maxWaitMs / 1000}s`,
      lastTransitionTime: new Date().toISOString(),
    }],
  });
  return false;
}


/**
 * Ensure a PVC exists for the module. Creates it if it doesn't already exist.
 * This is called from the reconciler before deployment creation or bootstrap restore,
 * so the PVC is guaranteed to exist before any pod tries to mount it.
 */
async function ensurePvc(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  pvcName: string,
  pvcSpec: K8s.V1PersistentVolumeClaimSpec,
  scheduleName?: string,
): Promise<void> {
  try {
    await coreV1Api.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: namespace,
    });
    log.debug(`PVC ${pvcName} already exists in namespace ${namespace}`);

    // Update the backup-schedule label to match current state
    if (scheduleName !== undefined) {
      try {
        await coreV1Api.patchNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace: namespace,
          body: {
            metadata: {
              labels: scheduleName
                ? { 'eevee.bot/backup-schedule': scheduleName }
                : { 'eevee.bot/backup-schedule': null },
            },
          },
        });
      } catch (error) {
        log.debug('Failed to update backup-schedule label on PVC:', error);
      }
    }
  } catch {
    // PVC doesn't exist — create it
    // Ensure the spec has the required resources.storage field
    if (!pvcSpec.resources) {
      pvcSpec.resources = {
        requests: {
          storage: '1Gi',
        },
      };
    } else if (!pvcSpec.resources.requests?.storage) {
      pvcSpec.resources.requests = {
        ...pvcSpec.resources.requests,
        storage: '1Gi',
      };
    }

    try {
      await coreV1Api.createNamespacedPersistentVolumeClaim({
        namespace: namespace,
        body: {
          metadata: {
            name: pvcName,
            labels: scheduleName
              ? { 'eevee.bot/backup-schedule': scheduleName }
              : undefined,
          },
          spec: pvcSpec,
        },
      });
      log.info(`Created PVC ${pvcName} in namespace ${namespace}`);
    } catch (error) {
      log.warn(`Failed to create PVC ${pvcName}:`, error);
    }
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
  } catch {
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
    await coreV1Api.patchNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: namespace,
      body: {
        metadata: {
          annotations: {
            'eevee.bot/bootstrapped': 'true',
          },
        },
      },
    });
    log.debug(`Set bootstrapped annotation on PVC ${pvcName}`);
  } catch (error) {
    log.debug(
      `Could not set bootstrapped annotation on PVC ${pvcName} (may not exist yet):`,
      error
    );
  }
}

/**
 * Update the status subresource on a botmodule CR.
 */
async function updateBotModuleStatus(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  status: Record<string, unknown>,
  terminal?: boolean
): Promise<void> {
  try {
    await customObjectsApi.patchNamespacedCustomObjectStatus({
      group: eevee.BotModule.details.group,
      version: eevee.BotModule.details.version,
      namespace: namespace,
      plural: eevee.BotModule.details.plural,
      name: name,
      body: {
        status: status,
      },
    });

    if (terminal) {
      await setReconcileLast(customObjectsApi, namespace, name);
    }
  } catch (error) {
    log.warn(
      `Failed to update status for BotModule "${name}" in namespace "${namespace}":`,
      error
    );
  }
}

async function setReconcileLast(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string
): Promise<void> {
  try {
    await customObjectsApi.patchNamespacedCustomObject({
      group: eevee.BotModule.details.group,
      version: eevee.BotModule.details.version,
      namespace: namespace,
      plural: eevee.BotModule.details.plural,
      name: name,
      body: {
        metadata: {
          annotations: {
            'eevee.bot/reconcile-last': new Date().toISOString(),
          },
        },
      },
    });
  } catch (error) {
    log.debug('Failed to set reconcile-last annotation:', error);
  }
}

/**
 * Read the deployment status and update the botmodule status accordingly.
 * Ready if replicas are available, Unavailable if degraded.
 */
async function updateBotModuleStatusFromDeployment(
  appsV1Api: K8s.AppsV1Api,
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  deploymentName: string,
): Promise<void> {
  try {
    const deployment = await appsV1Api.readNamespacedDeployment({
      name: deploymentName,
      namespace: namespace,
    });

    const replicas = deployment.status?.replicas || 0;
    const available = deployment.status?.availableReplicas || 0;
    const updated = deployment.status?.updatedReplicas || 0;
    const unavailable = deployment.status?.unavailableReplicas || 0;

    if (available > 0 && unavailable === 0) {
      await updateBotModuleStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'True',
          reason: 'AvailableReplicas',
          message: `Deployment ready (${available}/${replicas} replicas available)`,
          lastTransitionTime: new Date().toISOString(),
        }],
      });
    } else if (unavailable > 0) {
      await updateBotModuleStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'UnavailableReplicas',
          message: `Deployment unavailable (${unavailable} unavailable replica(s), ${available} available)`,
          lastTransitionTime: new Date().toISOString(),
        }],
      });
    } else if (replicas > 0 && available === 0) {
      // Rolling out — no replicas available yet but not explicitly unavailable
      await updateBotModuleStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'Unknown',
          reason: 'Updating',
          message: `Deployment updating (${updated}/${replicas} updated)`,
          lastTransitionTime: new Date().toISOString(),
        }],
      });
    } else {
      await updateBotModuleStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'True',
          reason: 'AvailableReplicas',
          message: 'Deployment exists',
          lastTransitionTime: new Date().toISOString(),
        }],
      });
    }
  } catch (error) {
    log.warn(
      `Failed to check deployment status for BotModule "${name}":`,
      error
    );
  }
}
