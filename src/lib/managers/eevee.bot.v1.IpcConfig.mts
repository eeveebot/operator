'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

import * as crypto from 'crypto';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';
import { parseBool, validateSecretNamespace, strategicMergePatchOptions, mergePatchOptions } from '../../lib/functions.mjs';
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
    group: eevee.IpcConfig.details.group,
    version: eevee.IpcConfig.details.version,
    plural: eevee.IpcConfig.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received IpcConfig resource event:', event);

  // Skip reconciliation if only status changed (our own status update bounced back).
  // generation increments on spec changes; observedGeneration records which generation
  // we last reconciled. If they match, this is a status-only update (including our own
  // "Reconciling" status write bouncing back) — no need to re-reconcile.
  if (event.type === ResourceEventType.Modified) {
    const obj = event.object as eevee.IpcConfig.IpcConfigResource;
    const currentGeneration = obj.metadata?.generation;
    const observedGeneration = obj.status?.conditions?.[0]?.observedGeneration;

    if (
      currentGeneration !== undefined &&
      observedGeneration !== undefined &&
      currentGeneration === observedGeneration
    ) {
      log.debug(
        `Skipping IpcConfig "${event.meta.name}" reconciliation — generation unchanged (observed=${observedGeneration}, current=${currentGeneration})`
      );
      return;
    }
  }

  // Track Kubernetes resource events
  k8sResourceEventsTotal.inc({
    resource_type: 'IpcConfig',
    event_type: event.type
  });

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `IpcConfig resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for added IpcConfig resource');
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added IpcConfig resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `IpcConfig resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Triggering reconciliation for modified IpcConfig resource');
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified IpcConfig resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `IpcConfig resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Processing deletion of IpcConfig resource');
      // Delete the associated resources when IpcConfig resource is deleted
      if (event.meta.namespace) {
        const deploymentName = `eevee-${event.meta.name}-nats`;
        const serviceName = `eevee-${event.meta.name}-nats`;
        const configSecretName = `${deploymentName}-config`;

        // Delete deployment
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
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
            `Failed to delete deployment ${deploymentName} in namespace ${event.meta.namespace}:`,
            error
          );
        }

        // Delete service
        try {
          const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
          log.debug(
            `Attempting to delete service ${serviceName} in namespace ${event.meta.namespace}`
          );
          await coreV1Api.deleteNamespacedService({
            name: serviceName,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted service ${serviceName} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete service ${serviceName} in namespace ${event.meta.namespace}:`,
            error
          );
        }

        // Delete config secret
        try {
          const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
          log.debug(
            `Attempting to delete secret ${configSecretName} in namespace ${event.meta.namespace}`
          );
          await coreV1Api.deleteNamespacedSecret({
            name: configSecretName,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted secret ${configSecretName} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete secret ${configSecretName} in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete resources for IpcConfig ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of IpcConfig resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting ipcconfig reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to ipcconfig reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
  let generation: number | undefined;

  try {
    // Get the specific resource that changed
    const resourceName = event.meta.name;
    const resourceNamespace = event.meta.namespace;

    if (!resourceName || !resourceNamespace) {
      log.error('Resource name or namespace missing from event');
      return;
    }

    log.debug(
      `Processing IpcConfig resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the specific IpcConfig resource
    const ipcConfigResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.IpcConfig.details.group,
      version: eevee.IpcConfig.details.version,
      namespace: resourceNamespace,
      plural: eevee.IpcConfig.details.plural,
      name: resourceName,
    });

    // Validate that the response contains a body
    if (!ipcConfigResponse) {
      log.error(
        `Failed to retrieve IpcConfig resource ${resourceName} in namespace ${resourceNamespace}: Empty or invalid response`
      );
      return;
    }

    const item = ipcConfigResponse as eevee.IpcConfig.IpcConfigResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;
    const uid = item.metadata?.uid;
    generation = item.metadata?.generation;

    if (!namespace || !name) {
      log.debug('Skipping IpcConfig resource with missing namespace or name');
      return;
    }

    if (!uid) {
      log.debug('Skipping IpcConfig resource with missing UID');
      return;
    }

    // Generate deployment name based on ipcconfig custom resource object name
    const deploymentName = `eevee-${name}-nats`;
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
        `Deployment ${deploymentName} already exists in namespace ${namespace} — updating`
      );
      await updateNatsDeployment(appsV1Api, namespace, name, uid, item);
    } catch {
      // Deployment doesn't exist, create it
      log.info(
        `Creating deployment ${deploymentName} in namespace ${namespace}`
      );
      await createNatsDeployment(appsV1Api, namespace, name, uid, item);
    }

    // Ensure the corresponding service exists or is updated
    log.debug(
      `Ensuring service exists for IpcConfig ${name} in namespace ${namespace}`
    );
    await createOrUpdateNatsService(coreV1Api, namespace, name, uid);
    log.debug(
      `Service check completed for IpcConfig ${name} in namespace ${namespace}`
    );
    log.debug('IpcConfig reconciliation completed successfully');

    await updateIpcConfigStatus(customObjectsApi, namespace, name, {
      conditions: [{
        type: 'Ready',
        status: 'True',
        reason: 'NatsDeployed',
        message: `NATS deployment and service are configured`,
        lastTransitionTime: new Date().toISOString(),
      }],
    }, generation);
  } catch (error) {
    log.error('Error during ipcconfig reconciliation:', error);
    // Try to set error status — best effort
    try {
      const resourceName = event.meta.name;
      const resourceNamespace = event.meta.namespace;
      if (resourceName && resourceNamespace) {
        await updateIpcConfigStatus(customObjectsApi, resourceNamespace, resourceName, {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'ReconcileFailed',
            message: `Reconciliation failed: ${error}`,
            lastTransitionTime: new Date().toISOString(),
          }],
        }, generation);
      }
    } catch (statusError) {
      log.debug('Failed to update error status:', statusError);
    }
  }
}

async function createNatsDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ipcConfigName: string,
  uid: string,
  item: eevee.IpcConfig.IpcConfigResource
): Promise<void> {
  log.debug(
    `Creating NATS deployment for ${ipcConfigName} in namespace ${namespace}`
  );

  // Try to fetch the IPC config to get NATS token settings
  const natsEnvVars: K8s.V1EnvVar[] = [];
  let natsTokenSecretName: string | undefined;

  log.debug('Processing NATS token configuration');
  try {
    const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);

    const ipcConfig = item as eevee.IpcConfig.IpcConfigResource;
    const natsTokenConfig = ipcConfig?.spec?.nats?.token;

    if (natsTokenConfig?.secretKeyRef) {
      natsTokenSecretName =
        natsTokenConfig.secretKeyRef.secret.name || 'nats-token';
      validateSecretNamespace(
        natsTokenSecretName,
        natsTokenConfig.secretKeyRef.secret.namespace,
        namespace,
        `IpcConfig "${ipcConfigName}" NATS token`
      );
      log.debug(`Found NATS token secret reference: ${natsTokenSecretName}`);

      // Check if the secret exists, and create it if it doesn't
      try {
        await coreV1Api.readNamespacedSecret({
          name: natsTokenSecretName,
          namespace: namespace,
        });
        log.debug(
          `Secret ${natsTokenSecretName} already exists in namespace ${namespace}`
        );
      } catch {
        // Secret doesn't exist, create it
        log.info(
          `Creating secret ${natsTokenSecretName} in namespace ${namespace}`
        );
        await createNatsTokenSecret(
          coreV1Api,
          namespace,
          natsTokenSecretName,
          ipcConfigName,
          uid
        );
      }

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
    } else {
      log.debug('No NATS token configuration found in IPC config');
    }
  } catch (error) {
    log.warn(
      `Failed to process IPC config ${ipcConfigName} for NATS settings:`,
      error
    );
  }

  // Generate deployment name based on ipcconfig name
  const deploymentName = `eevee-${ipcConfigName}-nats`;
  const configSecretName = `${deploymentName}-config`;
  log.debug(`Generated deployment name: ${deploymentName}`);
  log.debug(`Generated config secret name: ${configSecretName}`);

  // Get the NATS token from the secret if it exists
  let natsToken = '';
  if (natsTokenSecretName) {
    try {
      const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
      const secretResponse = await coreV1Api.readNamespacedSecret({
        name: natsTokenSecretName,
        namespace: namespace,
      });
      const secretData = secretResponse?.data;
      if (secretData && secretData.token) {
        // Decode base64 encoded token
        natsToken = Buffer.from(secretData.token, 'base64').toString('utf-8');
      }
    } catch (error) {
      log.warn(`Failed to read NATS token secret:`, error);
    }
  }

  // Create Secret for NATS configuration with embedded token
  await createNatsConfigSecret(
    kc.makeApiClient(K8s.CoreV1Api),
    namespace,
    configSecretName,
    ipcConfigName,
    uid,
    natsToken
  );

  // Prepare command arguments for NATS server with config file and auth
  const commandArgs = ['--config', '/etc/nats-config/nats.conf'];

  // Get the image from the IPC config spec if available
  let natsImage = 'docker.io/nats:latest';
  let natsImagePullPolicy: K8s.V1Container['imagePullPolicy'] = 'IfNotPresent';
  log.debug('Processing NATS image configuration');
  try {
    interface IpcConfigSpec {
      spec?: {
        nats?: {
          managed?: {
            image?: string;
            imagePullPolicy?: string;
          };
        };
      };
    }

    const ipcConfig = item as IpcConfigSpec;
    if (ipcConfig?.spec?.nats?.managed?.image) {
      natsImage = ipcConfig.spec.nats.managed.image;
      log.debug(`Using custom NATS image: ${natsImage}`);
    } else {
      log.debug(`Using default NATS image: ${natsImage}`);
    }
    if (ipcConfig?.spec?.nats?.managed?.imagePullPolicy) {
      natsImagePullPolicy = ipcConfig.spec.nats.managed.imagePullPolicy as K8s.V1Container['imagePullPolicy'];
    }
  } catch (error) {
    log.warn(
      `Failed to process IPC config ${ipcConfigName} for image settings:`,
      error
    );
  }

  log.debug('Creating deployment object');
  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
      ownerReferences: [
        {
          apiVersion: `${eevee.IpcConfig.details.group}/${eevee.IpcConfig.details.version}`,
          kind: eevee.IpcConfig.details.name,
          name: ipcConfigName,
          uid: uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'eevee.bot/nats-server': 'true',
          'eevee.bot/ipcconfig': ipcConfigName,
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/nats-server': 'true',
            'eevee.bot/ipcconfig': ipcConfigName,
          },
        },
        spec: {
          volumes: [
            {
              name: 'nats-config-volume',
              secret: {
                secretName: configSecretName,
              },
            },
          ],
          containers: [
            {
              name: 'nats-server',
              image: natsImage,
              imagePullPolicy: natsImagePullPolicy,
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
              resources: (item as eevee.IpcConfig.IpcConfigResource)?.spec?.nats?.managed?.resources as K8s.V1ResourceRequirements,
              volumeMounts: [
                {
                  name: 'nats-config-volume',
                  mountPath: '/etc/nats-config',
                  readOnly: true,
                },
              ],
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
    `Attempting to create NATS deployment ${deploymentName} in namespace ${namespace}`
  );
  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created NATS deployment ${deploymentName} in namespace ${namespace}`
    );
    log.debug(`NATS deployment creation completed for ${deploymentName}`);
  } catch (error) {
    log.error(
      `Failed to create NATS deployment in namespace ${namespace}:`,
      error
    );
  }
}

/**
 * Generates a random token for NATS authentication
 * @returns A random 16-character hexadecimal string
 */
function generateRandomToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Creates a Kubernetes secret containing a NATS authentication token
 * @param coreV1Api The Kubernetes CoreV1Api client
 * @param namespace The namespace to create the secret in
 * @param secretName The name of the secret to create
 * @param ipcConfigName The name of the IPC config custom resource
 */
async function updateNatsDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ipcConfigName: string,
  uid: string,
  item: eevee.IpcConfig.IpcConfigResource
): Promise<void> {
  const deploymentName = `eevee-${ipcConfigName}-nats`;
  const configSecretName = `${deploymentName}-config`;

  // Resolve NATS token configuration
  const natsEnvVars: K8s.V1EnvVar[] = [];
  let natsTokenSecretName: string | undefined;

  try {
    const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
    const natsTokenConfig = item?.spec?.nats?.token;

    if (natsTokenConfig?.secretKeyRef) {
      natsTokenSecretName = natsTokenConfig.secretKeyRef.secret.name || 'nats-token';
      validateSecretNamespace(
        natsTokenSecretName,
        natsTokenConfig.secretKeyRef.secret.namespace,
        namespace,
        `IpcConfig "${ipcConfigName}" NATS token`
      );

      // Ensure the token secret exists
      try {
        await coreV1Api.readNamespacedSecret({
          name: natsTokenSecretName,
          namespace: namespace,
        });
      } catch {
        await createNatsTokenSecret(coreV1Api, namespace, natsTokenSecretName, ipcConfigName, uid);
      }

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
    log.warn(`Failed to process NATS token config for update:`, error);
  }

  // Get the NATS token for the config secret
  let natsToken = '';
  if (natsTokenSecretName) {
    try {
      const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
      const secretResponse = await coreV1Api.readNamespacedSecret({
        name: natsTokenSecretName,
        namespace: namespace,
      });
      if (secretResponse?.data?.token) {
        natsToken = Buffer.from(secretResponse.data.token, 'base64').toString('utf-8');
      }
    } catch (error) {
      log.warn(`Failed to read NATS token secret for update:`, error);
    }
  }

  // Update the config secret
  await createNatsConfigSecret(
    kc.makeApiClient(K8s.CoreV1Api),
    namespace,
    configSecretName,
    ipcConfigName,
    uid,
    natsToken
  );

  // Resolve image
  const natsImage = item?.spec?.nats?.managed?.image || 'docker.io/nats:latest';
  const natsImagePullPolicy = (item?.spec?.nats?.managed?.imagePullPolicy || 'IfNotPresent') as K8s.V1Container['imagePullPolicy'];

  // Patch the deployment with updated container spec
  try {
    await appsV1Api.patchNamespacedDeployment({
      name: deploymentName,
      namespace: namespace,
      body: {
        spec: {
          template: {
            metadata: {
              labels: {
                app: 'eevee.bot',
                'eevee.bot/nats-server': 'true',
                'eevee.bot/ipcconfig': ipcConfigName,
              },
            },
            spec: {
              containers: [{
                name: 'nats-server',
                image: natsImage,
                imagePullPolicy: natsImagePullPolicy,
                env: natsEnvVars,
                resources: item?.spec?.nats?.managed?.resources as K8s.V1ResourceRequirements,
                volumeMounts: [{
                  name: 'nats-config-volume',
                  mountPath: '/etc/nats-config',
                  readOnly: true,
                }],
              }],
              volumes: [{
                name: 'nats-config-volume',
                secret: { secretName: configSecretName },
              }],
            },
          },
        },
      },
    }, strategicMergePatchOptions);
    log.info(`Updated NATS deployment ${deploymentName} in namespace ${namespace}`);
  } catch (error) {
    log.error(`Failed to update NATS deployment ${deploymentName}:`, error);
  }
}

async function createNatsTokenSecret(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  secretName: string,
  ipcConfigName: string,
  uid: string
): Promise<void> {
  // Generate a random token
  const token = generateRandomToken();

  // Create the secret object
  const secret: K8s.V1Secret = {
    metadata: {
      name: secretName,
      namespace: namespace,
      ownerReferences: [
        {
          apiVersion: `${eevee.IpcConfig.details.group}/${eevee.IpcConfig.details.version}`,
          kind: eevee.IpcConfig.details.name,
          name: ipcConfigName,
          uid: uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    type: 'Opaque',
    stringData: {
      token: `${token}`,
      host: `eevee-${ipcConfigName}-nats.${namespace}.svc.cluster.local`,
    },
  };

  try {
    await coreV1Api.createNamespacedSecret({
      namespace: namespace,
      body: secret,
    });
    log.info(
      `Successfully created secret ${secretName} in namespace ${namespace}`
    );
  } catch (error) {
    log.error(
      `Failed to create secret ${secretName} in namespace ${namespace}:`,
      error
    );
    throw error;
  }
}

/**
 * Creates a Kubernetes Secret containing NATS server configuration with embedded token
 * @param coreV1Api The Kubernetes CoreV1Api client
 * @param namespace The namespace to create the Secret in
 * @param configSecretName The name of the Secret to create
 * @param ipcConfigName The name of the IPC config custom resource
 * @param natsToken The NATS authentication token to embed in the configuration
 */
async function createNatsConfigSecret(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  configSecretName: string,
  ipcConfigName: string,
  uid: string,
  natsToken: string
): Promise<void> {
  // Define the NATS configuration with embedded token
  const natsConfig = `
# NATS Server Configuration
port: 4222
monitor_port: 8222
server_name: ${ipcConfigName}

# Logging configuration
debug: true
trace: false
logtime: false

# Authorization configuration
authorization {
  token: "${natsToken}"
}

# Store directory
store_dir: "/tmp/nats"

`;

  // Create the Secret object
  const configSecret: K8s.V1Secret = {
    metadata: {
      name: configSecretName,
      namespace: namespace,
      ownerReferences: [
        {
          apiVersion: `${eevee.IpcConfig.details.group}/${eevee.IpcConfig.details.version}`,
          kind: eevee.IpcConfig.details.name,
          name: ipcConfigName,
          uid: uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    type: 'Opaque',
    stringData: {
      'nats.conf': natsConfig.trim(),
    },
  };

  try {
    // Check if Secret already exists
    try {
      await coreV1Api.readNamespacedSecret({
        name: configSecretName,
        namespace: namespace,
      });
      log.debug(
        `Secret ${configSecretName} already exists in namespace ${namespace}`
      );
      // Patch the existing Secret
      await coreV1Api.patchNamespacedSecret({
        name: configSecretName,
        namespace: namespace,
        body: {
          stringData: configSecret.stringData,
        },
      }, strategicMergePatchOptions);
      log.info(
        `Successfully patched Secret ${configSecretName} in namespace ${namespace}`
      );
    } catch {
      // Secret doesn't exist, create it
      await coreV1Api.createNamespacedSecret({
        namespace: namespace,
        body: configSecret,
      });
      log.info(
        `Successfully created Secret ${configSecretName} in namespace ${namespace}`
      );
    }
  } catch (error) {
    log.error(
      `Failed to create/update Secret ${configSecretName} in namespace ${namespace}:`,
      error
    );
    throw error;
  }
}

/**
 * Creates or updates a Kubernetes service for the NATS deployment
 * @param coreV1Api The Kubernetes CoreV1Api client
 * @param namespace The namespace to create/update the service in
 * @param ipcConfigName The name of the IPC config custom resource
 */
async function createOrUpdateNatsService(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  ipcConfigName: string,
  uid: string
): Promise<void> {
  log.debug(
    `Creating or updating NATS service for ${ipcConfigName} in namespace ${namespace}`
  );

  // Generate service name based on ipcconfig name
  const serviceName = `eevee-${ipcConfigName}-nats`;
  log.debug(`Service name: ${serviceName}`);

  // Define the service object with ClusterIP type
  const desiredService: K8s.V1Service = {
    metadata: {
      name: serviceName,
      namespace: namespace,
      ownerReferences: [
        {
          apiVersion: `${eevee.IpcConfig.details.group}/${eevee.IpcConfig.details.version}`,
          kind: eevee.IpcConfig.details.name,
          name: ipcConfigName,
          uid: uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'eevee.bot/nats-server': 'true',
        'eevee.bot/ipcconfig': ipcConfigName,
      },
      ports: [
        {
          name: 'client',
          port: 4222,
          targetPort: 4222,
          protocol: 'TCP',
        },
        {
          name: 'management',
          port: 8222,
          targetPort: 8222,
          protocol: 'TCP',
        },
        {
          name: 'cluster',
          port: 6222,
          targetPort: 6222,
          protocol: 'TCP',
        },
      ],
    },
  };

  // Check if service already exists
  log.debug(
    `Checking if service ${serviceName} exists in namespace ${namespace}`
  );
  try {
    const existingServiceResponse = await coreV1Api.readNamespacedService({
      name: serviceName,
      namespace: namespace,
    });

    const existingService: K8s.V1Service = existingServiceResponse;

    // Compare the existing service with the desired configuration
    // Check selector, ports, and service type
    const selectorsMatch =
      JSON.stringify(existingService.spec?.selector) ===
      JSON.stringify(desiredService.spec?.selector);

    const portsMatch =
      JSON.stringify(existingService.spec?.ports) ===
      JSON.stringify(desiredService.spec?.ports);

    const typeMatch = existingService.spec?.type === desiredService.spec?.type;

    if (selectorsMatch && portsMatch && typeMatch) {
      log.debug(
        `Service ${serviceName} already exists with correct configuration in namespace ${namespace}`
      );
    } else {
      // Service exists but configuration differs, update it
      log.info(
        `Updating NATS service ${serviceName} in namespace ${namespace} due to configuration changes`
      );
      log.debug('Configuration differences detected:', {
        selectorsMatch,
        portsMatch,
        typeMatch,
      });

      try {
        await coreV1Api.patchNamespacedService({
          name: serviceName,
          namespace: namespace,
          body: desiredService,
        }, strategicMergePatchOptions);
        log.info(
          `Successfully patched service ${serviceName} in namespace ${namespace}`
        );
        log.debug(`Service update completed for ${serviceName}`);
      } catch (error) {
        log.error(
          `Failed to update service ${serviceName} in namespace ${namespace}:`,
          error
        );
        throw error;
      }
    }
  } catch {
    // Service doesn't exist, create it
    log.info(
      `Creating new NATS service ${serviceName} in namespace ${namespace}`
    );

    try {
      await coreV1Api.createNamespacedService({
        namespace: namespace,
        body: desiredService,
      });
      log.info(
        `Successfully created service ${serviceName} in namespace ${namespace}`
      );
      log.debug(`Service creation completed for ${serviceName}`);
    } catch (error) {
      log.error(
        `Failed to create service ${serviceName} in namespace ${namespace}:`,
        error
      );
      throw error;
    }
  }
}

/**
 * Update the status subresource of an IpcConfig CR.
 */
async function updateIpcConfigStatus(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  status: Record<string, unknown>,
  generation?: number
): Promise<void> {
  // Inject observedGeneration into each condition
  if (generation !== undefined && Array.isArray(status.conditions)) {
    for (const condition of status.conditions as Array<Record<string, unknown>>) {
      condition.observedGeneration = generation;
    }
  }

  try {
    await customObjectsApi.patchNamespacedCustomObjectStatus({
      group: eevee.IpcConfig.details.group,
      version: eevee.IpcConfig.details.version,
      namespace: namespace,
      plural: eevee.IpcConfig.details.plural,
      name: name,
      body: {
        status: status,
      },
    }, mergePatchOptions);
  } catch (error) {
    log.error(
      `Failed to update status for IpcConfig "${name}" in namespace "${namespace}":`,
      error
    );
  }
}
