'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

import { log } from '../../lib/logging.mjs';
import { resolveSecretKey, parseBool, createS3Client, validateSecretNamespace, mergePatchOptions } from '../../lib/functions.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';
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
    group: eevee.S3Store.details.group,
    version: eevee.S3Store.details.version,
    plural: eevee.S3Store.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received S3Store resource event:', event);

  // Track Kubernetes resource events
  k8sResourceEventsTotal.inc({
    resource_type: 'S3Store',
    event_type: event.type,
  });

  // Handle specific event types differently
  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `S3Store resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added S3Store resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `S3Store resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified S3Store resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `S3Store resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // No managed resources to clean up — s3store is referenced, not owner
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting s3store reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to s3store reconciler');
    return;
  }

  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);

  try {
    const resourceName = event.meta.name;
    const resourceNamespace = event.meta.namespace;

    if (!resourceName || !resourceNamespace) {
      log.error('Resource name or namespace missing from event');
      return;
    }

    log.debug(
      `Processing S3Store resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the specific S3Store resource
    const s3StoreResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.S3Store.details.group,
      version: eevee.S3Store.details.version,
      namespace: resourceNamespace,
      plural: eevee.S3Store.details.plural,
      name: resourceName,
    });

    if (!s3StoreResponse) {
      log.error(
        `Failed to retrieve S3Store resource ${resourceName} in namespace ${resourceNamespace}: Empty or invalid response`
      );
      return;
    }

    const item = s3StoreResponse as eevee.S3Store.S3StoreResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;

    if (!namespace || !name) {
      log.debug('Skipping S3Store resource with missing namespace or name');
      return;
    }

    // Validate that required spec fields are present
    const spec = item.spec;
    if (!spec?.endpoint || !spec?.bucket || !spec?.accessId || !spec?.accessKey) {
      log.warn(
        `S3Store "${name}" is missing required spec fields (endpoint, bucket, accessId, accessKey)`
      );
      await updateS3StoreStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            lastTransitionTime: new Date().toISOString(),
            message: 'Missing required spec fields',
            reason: 'InvalidSpec',
            status: 'False',
            type: 'Ready',
          },
        ],
      });
      return;
    }

    // Resolve credentials from Secrets
    let accessId: string | undefined;
    let secretKey: string | undefined;

    try {
      validateSecretNamespace(
        spec.accessId.secretKeyRef.secret.name!,
        spec.accessId.secretKeyRef.secret.namespace,
        namespace,
        `S3Store "${name}" accessId`
      );
      accessId = await resolveSecretKey(
        coreV1Api,
        namespace,
        spec.accessId.secretKeyRef.secret.name!,
        spec.accessId.secretKeyRef.secret.namespace || namespace,
        spec.accessId.secretKeyRef.key
      );
    } catch (error) {
      log.warn(
        `Failed to resolve accessId secret for S3Store "${name}":`,
        error
      );
    }

    try {
      validateSecretNamespace(
        spec.accessKey.secretKeyRef.secret.name!,
        spec.accessKey.secretKeyRef.secret.namespace,
        namespace,
        `S3Store "${name}" accessKey`
      );
      secretKey = await resolveSecretKey(
        coreV1Api,
        namespace,
        spec.accessKey.secretKeyRef.secret.name!,
        spec.accessKey.secretKeyRef.secret.namespace || namespace,
        spec.accessKey.secretKeyRef.key
      );
    } catch (error) {
      log.warn(
        `Failed to resolve accessKey secret for S3Store "${name}":`,
        error
      );
    }

    if (!accessId || !secretKey) {
      const missing = [];
      if (!accessId) missing.push('accessId');
      if (!secretKey) missing.push('accessKey');
      const message = `Failed to resolve S3 credentials: ${missing.join(', ')} not found in Secrets`;
      log.warn(`S3Store "${name}" — ${message}`);
      await updateS3StoreStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            lastTransitionTime: new Date().toISOString(),
            message: message,
            reason: 'SecretNotFound',
            status: 'False',
            type: 'Ready',
          },
        ],
      });
      return;
    }

    // Test the S3 connection
    log.info(`Testing S3 connection for S3Store "${name}"`);
    const connectionOk = await testS3Connection(
      spec.endpoint,
      accessId,
      secretKey,
      spec.bucket,
      spec.pathStyle || false,
      spec.region
    );

    if (connectionOk) {
      log.info(`S3Store "${name}" connection test succeeded`);
      await updateS3StoreStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            lastTransitionTime: new Date().toISOString(),
            message: 'S3 connection test succeeded',
            reason: 'ConnectionSuccessful',
            status: 'True',
            type: 'Ready',
          },
        ],
      });
    } else {
      log.warn(`S3Store "${name}" connection test failed`);
      await updateS3StoreStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            lastTransitionTime: new Date().toISOString(),
            message: 'S3 connection test failed',
            reason: 'ConnectionFailed',
            status: 'False',
            type: 'Ready',
          },
        ],
      });
    }

    log.debug('S3Store reconciliation completed successfully');

    // Set the reconcile-last annotation to record when reconciliation completed
    try {
      await customObjectsApi.patchNamespacedCustomObject({
        group: eevee.S3Store.details.group,
        version: eevee.S3Store.details.version,
        namespace: namespace,
        plural: eevee.S3Store.details.plural,
        name: name,
        body: {
          metadata: {
            annotations: {
              'eevee.bot/reconcile-last': new Date().toISOString(),
            },
          },
        },
      }, mergePatchOptions);
    } catch (error) {
      log.debug('Failed to set reconcile-last annotation:', error);
    }
  } catch (error) {
    log.error('Error during s3store reconciliation:', error);
  }
}

/**
 * Test S3 connectivity by attempting a HeadBucket or ListObjectsV2.
 * Uses the AWS SDK-style HTTP request since we're in the operator
 * and don't have s3cmd available.
 */
async function testS3Connection(
  endpoint: string,
  accessId: string,
  secretKey: string,
  bucket: string,
  pathStyle: boolean,
  region?: string
): Promise<boolean> {
  try {
    const client = createS3Client(endpoint, accessId, secretKey, pathStyle, region);

    const command = new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1,
    });

    await client.send(command);
    return true;
  } catch (error) {
    log.warn('S3 connection test failed:', error);
    return false;
  }
}

/**
 * Update the status subresource of an S3Store CR.
 */
async function updateS3StoreStatus(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  status: Record<string, unknown>
): Promise<void> {
  try {
    await customObjectsApi.patchNamespacedCustomObjectStatus({
      group: eevee.S3Store.details.group,
      version: eevee.S3Store.details.version,
      namespace: namespace,
      plural: eevee.S3Store.details.plural,
      name: name,
      body: {
        status: status,
      },
    }, mergePatchOptions);
  } catch (error) {
    log.error(
      `Failed to update status for S3Store "${name}" in namespace "${namespace}":`,
      error
    );
  }
}
