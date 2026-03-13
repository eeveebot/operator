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
    group: eevee.ChatConnectionIrc.details.group,
    version: eevee.ChatConnectionIrc.details.version,
    plural: eevee.ChatConnectionIrc.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received ChatConnectionIrc resource event:', event);

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `ChatConnectionIrc resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug(
        'Triggering reconciliation for added ChatConnectionIrc resource'
      );
      // The reconciler will ensure the deployment exists
      try {
        await reconcileResource(kc, event);
        log.debug(
          'Reconciliation completed for added ChatConnectionIrc resource'
        );
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `ChatConnectionIrc resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug(
        'Triggering reconciliation for modified ChatConnectionIrc resource'
      );
      // The reconciler will ensure the deployment is in the correct state
      try {
        await reconcileResource(kc, event);
        log.debug(
          'Reconciliation completed for modified ChatConnectionIrc resource'
        );
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `ChatConnectionIrc resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      log.debug('Processing deletion of ChatConnectionIrc resource');
      // Delete the associated deployment when ChatConnectionIrc resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          const deploymentName = `eevee-${event.meta.name}-irc-connector`;
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
            `Failed to delete deployment eevee-${event.meta.name}-irc-connector in namespace ${event.meta.namespace}:`,
            error
          );
        }
      } else {
        log.warn(
          `Cannot delete deployment for ChatConnectionIrc ${event.meta.name} - no namespace specified`
        );
      }
      log.debug('Completed processing of ChatConnectionIrc resource deletion');
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting chatconnectionirc reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to chatconnectionirc reconciler');
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
      `Processing ChatConnectionIrc resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the specific ChatConnectionIrc resource
    const chatConnectionIrcResponse =
      await customObjectsApi.getNamespacedCustomObject({
        group: eevee.ChatConnectionIrc.details.group,
        version: eevee.ChatConnectionIrc.details.version,
        namespace: resourceNamespace,
        plural: eevee.ChatConnectionIrc.details.plural,
        name: resourceName,
      });

    // Validate that the response contains a body
    if (!chatConnectionIrcResponse) {
      log.error(
        `Failed to retrieve ChatConnectionIrc resource ${resourceName} in namespace ${resourceNamespace}: Empty or invalid response`
      );
      return;
    }

    const item =
      chatConnectionIrcResponse as eevee.ChatConnectionIrc.chatconnectionircResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;

    if (!namespace || !name) {
      log.debug(
        'Skipping ChatConnectionIrc resource with missing namespace or name'
      );
      return;
    }

    // Generate deployment name based on chatconnectionirc custom resource object name
    const deploymentName = `eevee-${name}-irc-connector`;
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
      await createIrcConnectorDeployment(appsV1Api, namespace, name, item);
    }

    // No service needed for IRC connector
    log.debug('No service required for IRC connector');
    log.debug('ChatConnectionIrc reconciliation completed successfully');
  } catch (error) {
    log.error('Error during chatconnectionirc reconciliation:', error);
  }
}

/**
 * Generates a YAML configuration from the connections spec, resolving any secret references
 */
async function generateConnectionsConfig(
  connections: eevee.ChatConnectionIrc.IrcConnection[],
  coreV1Api: K8s.CoreV1Api,
  namespace: string
): Promise<string> {
  log.debug('Generating connections configuration from spec');

  // Process each connection to handle secret references
  const processedConnections = [];
  for (const connection of connections) {
    const processedConnection = { ...connection };

    // Process postConnect actions that might have secret references
    if (processedConnection.postConnect) {
      for (const action of processedConnection.postConnect) {
        if (
          action.msg?.secretKeyRef?.secret?.name &&
          action.msg?.secretKeyRef?.key
        ) {
          try {
            const secretName = action.msg.secretKeyRef.secret.name;
            const secretKey = action.msg.secretKeyRef.key;

            // Fetch the secret
            const secretResponse = await coreV1Api.readNamespacedSecret({
              name: secretName,
              namespace: namespace,
            });
            const secretData = secretResponse.data;

            if (secretData && secretData[secretKey]) {
              // Decode base64 encoded secret value
              const decodedValue = Buffer.from(
                secretData[secretKey],
                'base64'
              ).toString('utf-8');
              // Replace the secretKeyRef with the actual value
              action.msg.msg = decodedValue;
              delete (action.msg as { secretKeyRef?: unknown }).secretKeyRef;
            }
          } catch (err) {
            log.warn(
              `Failed to process secret reference for message in connection ${connection.name}:`,
              err
            );
          }
        }

        if (action.join) {
          for (const channel of action.join) {
            const chan = channel as {
              secretKeyRef?: { secret: { name: string }; key: string };
              key?: string;
            };
            if (chan.secretKeyRef?.secret?.name && chan.secretKeyRef?.key) {
              try {
                const secretName = chan.secretKeyRef.secret.name;
                const secretKey = chan.secretKeyRef.key;

                // Fetch the secret
                const secretResponse = await coreV1Api.readNamespacedSecret({
                  name: secretName,
                  namespace: namespace,
                });
                const secretData = secretResponse.data;

                if (secretData && secretData[secretKey]) {
                  // Decode base64 encoded secret value
                  const decodedValue = Buffer.from(
                    secretData[secretKey],
                    'base64'
                  ).toString('utf-8');
                  // Replace the secretKeyRef with the actual value
                  chan.key = decodedValue;
                  delete chan.secretKeyRef;
                }
              } catch (err) {
                log.warn(
                  `Failed to process secret reference for channel key in connection ${connection.name}:`,
                  err
                );
              }
            }
          }
        }
      }
    }

    processedConnections.push(processedConnection);
  }

  // Convert to YAML format (simplified - in practice you might want to use a proper YAML library)
  const configObject = {
    connections: processedConnections,
  };

  // Simple JSON.stringify for now - in production you'd want proper YAML serialization
  return JSON.stringify(configObject, null, 2);
}

/**
 * Creates or updates a Kubernetes Secret containing the IRC connections configuration
 */
async function createConnectionsConfigSecret(
  coreV1Api: K8s.CoreV1Api,
  namespace: string,
  ircConfigName: string,
  connections: eevee.ChatConnectionIrc.IrcConnection[]
): Promise<void> {
  const secretName = `eevee-${ircConfigName}-irc-connections-config`;
  const configContent = await generateConnectionsConfig(
    connections,
    coreV1Api,
    namespace
  );

  const secret: K8s.V1Secret = {
    metadata: {
      name: secretName,
      namespace: namespace,
    },
    type: 'Opaque',
    data: {
      'connections.yaml': Buffer.from(configContent).toString('base64'),
    },
  };

  try {
    // Try to update existing secret first
    await coreV1Api.replaceNamespacedSecret({
      name: secretName,
      namespace: namespace,
      body: secret,
    });
    log.debug(
      `Updated existing secret ${secretName} in namespace ${namespace}`
    );
  } catch (err) {
    log.debug('Secret update failed, attempting to create new secret:', err);
    // If update fails, try to create new secret
    try {
      await coreV1Api.createNamespacedSecret({
        namespace: namespace,
        body: secret,
      });
      log.debug(`Created new secret ${secretName} in namespace ${namespace}`);
    } catch (createErr) {
      log.error(
        `Failed to create/update secret ${secretName} in namespace ${namespace}:`,
        createErr
      );
      throw createErr;
    }
  }
}

async function createIrcConnectorDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ircConfigName: string,
  item: eevee.ChatConnectionIrc.chatconnectionircResource
): Promise<void> {
  log.debug(
    `Creating IRC connector deployment for ${ircConfigName} in namespace ${namespace}`
  );

  // Generate deployment name based on chatconnectionirc name
  const deploymentName = `eevee-${ircConfigName}-irc-connector`;
  log.debug(`Generated deployment name: ${deploymentName}`);

  // Get the image from the ChatConnectionIrc spec if available
  let ircImage = 'ghcr.io/eeveebot/connector-irc:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';

  log.debug('Processing ChatConnectionIrc spec for configuration');
  try {
    const ircConfig = item as eevee.ChatConnectionIrc.chatconnectionircResource;
    if (ircConfig?.spec?.image) {
      ircImage = ircConfig.spec.image;
      log.debug(`Using custom image: ${ircImage}`);
    }
    if (ircConfig?.spec?.metrics !== undefined) {
      metricsEnabled = ircConfig.spec.metrics;
      log.debug(`Metrics enabled: ${metricsEnabled}`);
    }
    if (ircConfig?.spec?.metricsPort) {
      metricsPort = ircConfig.spec.metricsPort;
      log.debug(`Metrics port: ${metricsPort}`);
    }
  } catch (error) {
    log.warn(
      `Failed to process ChatConnectionIrc ${ircConfigName} for settings:`,
      error
    );
  }

  // Create connections config secret if connections are specified
  const connections = item.spec?.connections;
  if (connections && connections.length > 0) {
    try {
      const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);
      await createConnectionsConfigSecret(
        coreV1Api,
        namespace,
        ircConfigName,
        connections
      );
    } catch (err) {
      log.error(`Failed to create connections config secret:`, err);
      // Continue with deployment creation even if secret creation fails
    }
  }

  // Prepare environment variables for the IRC connector
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
      value: ircConfigName,
    },
  ];

  // Add IRC connections config file environment variable if connections are specified
  if (connections && connections.length > 0) {
    containerEnvVars.push({
      name: 'IRC_CONNECTIONS_CONFIG_FILE',
      value: '/etc/irc-connections/connections.yaml',
    });
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
  }

  log.debug('Creating deployment object');

  // Prepare volume mounts for connections config if connections are specified
  const volumes: K8s.V1Volume[] = [];
  const volumeMounts: K8s.V1VolumeMount[] = [];

  if (connections && connections.length > 0) {
    volumes.push({
      name: 'irc-connections-config',
      secret: {
        secretName: `eevee-${ircConfigName}-irc-connections-config`,
      },
    });

    volumeMounts.push({
      name: 'irc-connections-config',
      mountPath: '/etc/irc-connections',
      readOnly: true,
    });
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
          'eevee.bot/irc-connector': 'true',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee.bot',
            'eevee.bot/irc-connector': 'true',
          },
        },
        spec: {
          volumes: volumes,
          containers: [
            {
              name: 'irc-connector',
              image: ircImage,
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
    `Attempting to create IRC connector deployment ${deploymentName} in namespace ${namespace}`
  );
  try {
    await appsV1Api.createNamespacedDeployment({
      namespace: namespace,
      body: deployment,
    });
    log.info(
      `Successfully created IRC connector deployment ${deploymentName} in namespace ${namespace}` +
        `${metricsEnabled ? ` with metrics enabled on port ${metricsPort}` : ''}`
    );
    log.debug(
      `IRC connector deployment creation completed for ${deploymentName}`
    );
  } catch (error) {
    log.error(
      `Failed to create IRC connector deployment in namespace ${namespace}:`,
      error
    );
  }
}
