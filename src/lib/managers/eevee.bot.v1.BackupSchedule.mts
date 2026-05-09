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
    group: eevee.BackupSchedule.details.group,
    version: eevee.BackupSchedule.details.version,
    plural: eevee.BackupSchedule.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received BackupSchedule resource event:', event);

  // Track Kubernetes resource events
  k8sResourceEventsTotal.inc({
    resource_type: 'BackupSchedule',
    event_type: event.type,
  });

  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `BackupSchedule resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added BackupSchedule resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `BackupSchedule resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified BackupSchedule resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `BackupSchedule resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // CronJob is owned by the backupschedule via ownerReference,
      // so K8s GC handles cleanup automatically.
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting backupschedule reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to backupschedule reconciler');
    return;
  }

  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
  const batchV1Api = kc.makeApiClient(K8s.BatchV1Api);
  const coreV1Api = kc.makeApiClient(K8s.CoreV1Api);

  try {
    const resourceName = event.meta.name;
    const resourceNamespace = event.meta.namespace;

    if (!resourceName || !resourceNamespace) {
      log.error('Resource name or namespace missing from event');
      return;
    }

    log.debug(
      `Processing BackupSchedule resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the BackupSchedule resource
    const scheduleResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.BackupSchedule.details.group,
      version: eevee.BackupSchedule.details.version,
      namespace: resourceNamespace,
      plural: eevee.BackupSchedule.details.plural,
      name: resourceName,
    });

    if (!scheduleResponse) {
      log.error(
        `Failed to retrieve BackupSchedule resource ${resourceName} in namespace ${resourceNamespace}`
      );
      return;
    }

    const item = scheduleResponse as eevee.BackupSchedule.backupscheduleResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;
    const uid = item.metadata?.uid;

    if (!namespace || !name || !uid) {
      log.debug('Skipping BackupSchedule resource with missing namespace, name, or uid');
      return;
    }

    const spec = item.spec;
    if (!spec?.schedule || !spec?.s3Store || !spec?.image) {
      log.warn(`BackupSchedule "${name}" is missing required spec fields`);
      return;
    }

    // Resolve the s3store reference
    const s3StoreName = spec.s3Store.name;
    log.debug(`Resolving s3store "${s3StoreName}" for BackupSchedule "${name}"`);

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
      log.warn(`Failed to resolve s3store "${s3StoreName}" for BackupSchedule "${name}":`, error);
      return;
    }

    if (!s3StoreSpec) {
      log.warn(`s3store "${s3StoreName}" has no spec`);
      return;
    }

    // Resolve the accessId and accessKey secret references
    const accessIdSecretName = s3StoreSpec.accessId?.secretKeyRef?.secret?.name;
    const accessIdSecretNamespace = s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace || namespace;
    const accessIdSecretKey = s3StoreSpec.accessId?.secretKeyRef?.key;
    const accessKeySecretName = s3StoreSpec.accessKey?.secretKeyRef?.secret?.name;
    const accessKeySecretNamespace = s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace || namespace;
    const accessKeySecretKey = s3StoreSpec.accessKey?.secretKeyRef?.key;

    // Find the botmodule that references this backupschedule
    let moduleName: string | undefined;
    let pvcName: string | undefined;
    let pvcSpec: K8s.V1PersistentVolumeClaimSpec | undefined;
    let volumeMountPath = '/data';

    try {
      // List botmodules in the namespace to find one referencing this schedule
      const botModulesResponse = await customObjectsApi.listNamespacedCustomObject({
        group: eevee.BotModule.details.group,
        version: eevee.BotModule.details.version,
        namespace: namespace,
        plural: eevee.BotModule.details.plural,
      });

      const items = (botModulesResponse as { items: eevee.BotModule.botmoduleResource[] }).items;
      for (const bm of items) {
        if (bm.spec?.backupSchedule?.name === name) {
          moduleName = bm.spec.moduleName || bm.metadata?.name;
          pvcSpec = bm.spec?.persistentVolumeClaim;
          volumeMountPath = bm.spec?.volumeMountPath || '/data';
          // PVC name follows the operator convention: eevee-<cr-name>-data
          pvcName = `eevee-${bm.metadata?.name}-data`;
          break;
        }
      }
    } catch (error) {
      log.warn(`Failed to list botmodules for BackupSchedule "${name}":`, error);
    }

    if (!moduleName) {
      log.warn(
        `No botmodule references BackupSchedule "${name}" — cannot determine backup target`
      );
      return;
    }

    // Build the CronJob
    const cronJobName = `${name}-backup`;

    const envVars: K8s.V1EnvVar[] = [
      { name: 'S3_ENDPOINT', value: s3StoreSpec.endpoint },
      { name: 'S3_BUCKET', value: s3StoreSpec.bucket },
      { name: 'S3_PREFIX', value: s3StoreSpec.prefix || '' },
      { name: 'S3_PATH_STYLE', value: String(s3StoreSpec.pathStyle || false) },
      { name: 'BACKUP_NAMESPACE', value: namespace },
      { name: 'BACKUP_MODULE', value: moduleName },
      { name: 'BACKUP_PVC_PATH', value: volumeMountPath },
    ];

    // Add S3 credentials from Secrets via env var references
    if (accessIdSecretName && accessIdSecretKey) {
      envVars.push({
        name: 'S3_ACCESS_ID',
        valueFrom: {
          secretKeyRef: {
            name: accessIdSecretName,
            key: accessIdSecretKey,
          },
        },
      });
    }

    if (accessKeySecretName && accessKeySecretKey) {
      envVars.push({
        name: 'S3_SECRET_KEY',
        valueFrom: {
          secretKeyRef: {
            name: accessKeySecretName,
            key: accessKeySecretKey,
          },
        },
      });
    }

    const volumes: K8s.V1Volume[] = [];
    const volumeMounts: K8s.V1VolumeMount[] = [];

    // Mount the botmodule's PVC
    if (pvcName) {
      volumes.push({
        name: 'module-data',
        persistentVolumeClaim: {
          claimName: pvcName,
        },
      });
      volumeMounts.push({
        name: 'module-data',
        mountPath: volumeMountPath,
        readOnly: true,
      });
    }

    const cronJob: K8s.V1CronJob = {
      metadata: {
        name: cronJobName,
        namespace: namespace,
        ownerReferences: [
          {
            apiVersion: `${eevee.BackupSchedule.details.group}/${eevee.BackupSchedule.details.version}`,
            kind: eevee.BackupSchedule.details.plural,
            name: name,
            uid: uid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      spec: {
        schedule: spec.schedule,
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        concurrencyPolicy: 'Forbid',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'OnFailure',
                volumes: volumes,
                containers: [
                  {
                    name: 'backup',
                    image: spec.image,
                    command: ['/usr/local/bin/backup.sh'],
                    env: envVars,
                    volumeMounts: volumeMounts,
                  },
                ],
              },
            },
          },
        },
      },
    };

    // Create or update the CronJob
    try {
      await batchV1Api.readNamespacedCronJob({
        name: cronJobName,
        namespace: namespace,
      });
      log.debug(`CronJob ${cronJobName} already exists — updating`);
      await batchV1Api.replaceNamespacedCronJob({
        name: cronJobName,
        namespace: namespace,
        body: cronJob,
      });
      log.info(`Updated CronJob ${cronJobName} in namespace ${namespace}`);
    } catch {
      log.info(`Creating CronJob ${cronJobName} in namespace ${namespace}`);
      await batchV1Api.createNamespacedCronJob({
        namespace: namespace,
        body: cronJob,
      });
      log.info(`Created CronJob ${cronJobName} in namespace ${namespace}`);
    }

    // Update the backupschedule status
    await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
      cronJobName: cronJobName,
    });

    log.debug('BackupSchedule reconciliation completed successfully');
  } catch (error) {
    log.error('Error during backupschedule reconciliation:', error);
  }
}

/**
 * Update the status subresource of a BackupSchedule CR.
 */
async function updateBackupScheduleStatus(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  status: Record<string, unknown>
): Promise<void> {
  try {
    await customObjectsApi.patchNamespacedCustomObjectStatus({
      group: eevee.BackupSchedule.details.group,
      version: eevee.BackupSchedule.details.version,
      namespace: namespace,
      plural: eevee.BackupSchedule.details.plural,
      name: name,
      body: {
        status: status,
      },
    });
  } catch (error) {
    log.error(
      `Failed to update status for BackupSchedule "${name}" in namespace "${namespace}":`,
      error
    );
  }
}
