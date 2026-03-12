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
            name: `eevee-connector-irc-${event.meta.name}`,
            namespace: event.meta.namespace,
          });
          log.info(
            `Deleted deployment eevee-connector-irc-${event.meta.name} in namespace ${event.meta.namespace}`
          );
        } catch (error) {
          log.error(
            `Failed to delete deployment eevee-connector-irc-${event.meta.name} in namespace ${event.meta.namespace}:`,
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
        const deploymentName = `eevee-connector-irc-${name}`;

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
  item: { spec?: { ipcConfig?: string } }
): Promise<void> {
  // Generate deployment name based on chatconnectionirc name
  const deploymentName = `eevee-connector-irc-${ircConfigName}`;

  // Get the IPC config name from the ChatConnectionIrc resource
  const ipcConfigName = item.spec?.ipcConfig;

  // Prepare environment variables for the IRC connector
  const envVars: K8s.V1EnvVar[] = [
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

  const deployment: K8s.V1Deployment = {
    metadata: {
      name: deploymentName,
      namespace: namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'eevee-connector-irc',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'eevee-connector-irc',
          },
        },
        spec: {
          containers: [
            {
              name: 'connector-irc',
              image: 'ghcr.io/eeveebot/connector-irc:latest',
              imagePullPolicy: 'Always',
              env: envVars,
              ports: [
                {
                  containerPort: 8080,
                  name: 'metrics',
                },
              ],
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
      `Successfully created IRC connector deployment ${deploymentName} in namespace ${namespace}`
    );
  } catch (error) {
    log.error(
      `Failed to create IRC connector deployment in namespace ${namespace}:`,
      error
    );
  }
}
