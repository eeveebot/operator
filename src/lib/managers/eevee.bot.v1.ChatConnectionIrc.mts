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
    group: eevee.ChatConnectionIrc.details.group,
    version: eevee.ChatConnectionIrc.details.version,
    plural: eevee.ChatConnectionIrc.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(
    'Received ChatConnectionIrc resource event:',
    event.type,
    event.meta.name,
    event.meta.namespace
  );

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `ChatConnectionIrc resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
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
        `ChatConnectionIrc resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
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
        `ChatConnectionIrc resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // Delete the associated deployment when ChatConnectionIrc resource is deleted
      if (event.meta.namespace) {
        try {
          const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
          await appsV1Api.deleteNamespacedDeployment({
            name: `eevee-${event.meta.name}-irc-connector`,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted deployment eevee-${event.meta.name}-irc-connector in namespace ${event.meta.namespace}`
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
      // No reconciliation needed for deletions
      break;
  }
}

async function reconcileResource(kc?: K8s.KubeConfig): Promise<void> {
  if (!kc) {
    log.error('KubeConfig not provided to chatconnectionirc reconciler');
    return;
  }

  const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

  try {
    // List all ChatConnectionIrc custom resources
    const chatConnectionIrcList =
      await customObjectsApi.listCustomObjectForAllNamespaces({
        group: eevee.ChatConnectionIrc.details.group,
        version: eevee.ChatConnectionIrc.details.version,
        plural: eevee.ChatConnectionIrc.details.plural,
      });

    // For each ChatConnectionIrc resource, ensure a deployment exists in its namespace
    if (chatConnectionIrcList.body?.items) {
      for (const item of chatConnectionIrcList.body.items) {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) continue;

        // Generate deployment name based on chatconnectionirc custom resource object name
        const deploymentName = `eevee-${name}-irc-connector`;

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
      }
    }
  } catch (error) {
    log.error('Error during chatconnectionirc reconciliation:', error);
  }
}

async function createIrcConnectorDeployment(
  appsV1Api: K8s.AppsV1Api,
  namespace: string,
  ircConfigName: string,
  item: eevee.ChatConnectionIrc.chatconnectionircResource
): Promise<void> {
  // Generate deployment name based on chatconnectionirc name
  const deploymentName = `eevee-${ircConfigName}-irc-connector`;

  // Get the image from the ChatConnectionIrc spec if available
  let ircImage = 'ghcr.io/eeveebot/connector-irc:latest';
  let metricsEnabled = false;
  let metricsPort = 8080;
  const pullPolicy: K8s.V1Container['imagePullPolicy'] = 'Always';

  try {
    const ircConfig = item as eevee.ChatConnectionIrc.chatconnectionircResource;
    if (ircConfig?.spec?.image) {
      ircImage = ircConfig.spec.image;
    }
    if (ircConfig?.spec?.metrics !== undefined) {
      metricsEnabled = ircConfig.spec.metrics;
    }
    if (ircConfig?.spec?.metricsPort) {
      metricsPort = ircConfig.spec.metricsPort;
    }
  } catch (error) {
    log.warn(
      `Failed to process ChatConnectionIrc ${ircConfigName} for settings:`,
      error
    );
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

  // Prepare container ports
  const containerPorts: K8s.V1ContainerPort[] = [];

  // Add metrics port if metrics are enabled
  if (metricsEnabled) {
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
          containers: [
            {
              name: 'irc-connector',
              image: ircImage,
              imagePullPolicy: pullPolicy,
              env: containerEnvVars,
              ports: containerPorts,
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
      `Successfully created IRC connector deployment ${deploymentName} in namespace ${namespace}` +
        `${metricsEnabled ? ` with metrics enabled on port ${metricsPort}` : ''}`
    );
  } catch (error) {
    log.error(
      `Failed to create IRC connector deployment in namespace ${namespace}:`,
      error
    );
  }
}
