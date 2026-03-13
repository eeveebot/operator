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
      log.debug('Triggering reconciliation for added IpcConfig resource');
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc);
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
        await reconcileResource(kc);
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
      // Delete the associated deployment when IpcConfig resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          const deploymentName = `eevee-${event.meta.name}-nats`;
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
            `Failed to delete deployment eevee-${event.meta.name}-nats in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for IpcConfig ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of IpcConfig resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(kc?: K8s.KubeConfig): Promise<void> {
  log.debug('Starting ipcconfig reconciliation');
  if (!kc) {
    log.error('KubeConfig not provided to ipcconfig reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    log.debug('Listing all IpcConfig custom resources');
    // List all IpcConfig custom resources
    const ipcConfigList =
      await customObjectsApi.listCustomObjectForAllNamespaces({
        group: eevee.IpcConfig.details.group,
        version: eevee.IpcConfig.details.version,
        plural: eevee.IpcConfig.details.plural,
      });
    log.debug('Successfully listed IpcConfig resources');

    // For each IpcConfig resource, ensure a deployment exists in its namespace
    if (ipcConfigList.body?.items) {
      log.debug(
        `Processing ${ipcConfigList.body.items.length} IpcConfig resources`
      );
      for (const item of ipcConfigList.body
        .items as eevee.IpcConfig.ipcconfigResource[]) {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) {
          log.debug(
            'Skipping IpcConfig resource with missing namespace or name'
          );
          continue;
        }
        log.debug(
          `Processing IpcConfig resource ${name} in namespace ${namespace}`
        );

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
            `Deployment ${deploymentName} already exists in namespace ${namespace}`
          );
        } catch {
          // Deployment doesn't exist, create it
          log.info(
            `Creating deployment ${deploymentName} in namespace ${namespace}`
          );
          await createNatsDeployment(appsV1Api, namespace, name, item);
        }

        // Ensure the corresponding service exists or is updated
        log.debug(
          `Ensuring service exists for IpcConfig ${name} in namespace ${namespace}`
        );
        await createOrUpdateNatsService(coreV1Api, namespace, name);
        log.debug(
          `Service check completed for IpcConfig ${name} in namespace ${namespace}`
        );
      }
      log.debug('Finished processing all IpcConfig resources');
    }
    log.debug('IpcConfig reconciliation completed successfully');
  } catch (error) {
    log.error('Error during ipcconfig reconciliation:', error);
  }
}

async function createNatsDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ipcConfigName: string,
  item: eevee.IpcConfig.ipcconfigResource
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

    const ipcConfig = item as eevee.IpcConfig.ipcconfigResource;
    const natsTokenConfig = ipcConfig?.spec?.nats?.token;

    if (natsTokenConfig?.secretKeyRef) {
      natsTokenSecretName =
        natsTokenConfig.secretKeyRef.secret.name || 'nats-token';
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
          ipcConfigName
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
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Prepare command arguments for NATS server with auth
  const commandArgs = ['--auth', '$NATS_TOKEN'];

  // Get the image from the IPC config spec if available
  let natsImage = 'docker.io/nats:latest';
  log.debug('Processing NATS image configuration');
  try {
    interface IpcConfigSpec {
      spec?: {
        nats?: {
          managed?: {
            image?: string;
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
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'eevee.bot/nats-server': 'true',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/nats-server': 'true',
          },
        },
        spec: {
          containers: [
            {
              name: 'nats-server',
              image: natsImage,
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
 * @returns A random 32-character hexadecimal string
 */
function generateRandomToken(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

/**
 * Creates a Kubernetes secret containing a NATS authentication token
 * @param coreV1Api The Kubernetes CoreV1Api client
 * @param namespace The namespace to create the secret in
 * @param secretName The name of the secret to create
 * @param ipcConfigName The name of the IPC config custom resource
 */
async function createNatsTokenSecret(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  secretName: string,
  ipcConfigName: string
): Promise<void> {
  // Generate a random token
  const token = generateRandomToken();

  // Create the secret object
  const secret: K8s.V1Secret = {
    metadata: {
      name: secretName,
      namespace: namespace,
    },
    type: 'Opaque',
    data: {
      token: Buffer.from(token).toString('base64'),
      host: Buffer.from(
        `eevee-${ipcConfigName}-nats.${namespace}.svc.cluster.local`
      ).toString('base64'),
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
 * Creates or updates a Kubernetes service for the NATS deployment
 * @param coreV1Api The Kubernetes CoreV1Api client
 * @param namespace The namespace to create/update the service in
 * @param ipcConfigName The name of the IPC config custom resource
 */
async function createOrUpdateNatsService(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  ipcConfigName: string
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
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'eevee.bot/nats-server': 'true',
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
        await coreV1Api.replaceNamespacedService({
          name: serviceName,
          namespace: namespace,
          body: desiredService,
        });
        log.info(
          `Successfully updated service ${serviceName} in namespace ${namespace}`
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
