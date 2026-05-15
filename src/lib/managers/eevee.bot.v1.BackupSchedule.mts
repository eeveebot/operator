'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent, ResourceEventType } from '@thehonker/k8s-operator';
import * as K8s from '@kubernetes/client-node';

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

    const item = scheduleResponse as eevee.BackupSchedule.BackupScheduleResource;
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
      await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'InvalidSpec',
            message: 'Missing required spec fields (schedule, s3Store, image)',
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      }, true);
      return;
    }

    // Resolve the s3store reference
    const s3StoreName = spec.s3Store.name;
    log.debug(`Resolving s3store "${s3StoreName}" for BackupSchedule "${name}"`);

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
        log.warn(`S3Store "${s3StoreName}" is not ready (${reason}) for BackupSchedule "${name}"`);
        await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'S3StoreNotReady',
            message: msg,
            lastTransitionTime: new Date().toISOString(),
          }],
        }, true);
        return;
      }
    } catch (error) {
      log.warn(`Failed to resolve s3store "${s3StoreName}" for BackupSchedule "${name}":`, error);
      await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'S3StoreNotFound',
            message: `Failed to resolve s3store "${s3StoreName}"`,
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      }, true);
      return;
    }

    if (!s3StoreSpec) {
      log.warn(`s3store "${s3StoreName}" has no spec`);
      await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'S3StoreInvalid',
            message: `s3store "${s3StoreName}" has no spec`,
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      }, true);
      return;
    }

    // Resolve the accessId and accessKey secret references
    const accessIdSecretName = s3StoreSpec.accessId?.secretKeyRef?.secret?.name;
    const accessIdSecretNamespace = s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace || namespace;
    const accessIdSecretKey = s3StoreSpec.accessId?.secretKeyRef?.key;
    const accessKeySecretName = s3StoreSpec.accessKey?.secretKeyRef?.secret?.name;
    const accessKeySecretNamespace = s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace || namespace;
    const accessKeySecretKey = s3StoreSpec.accessKey?.secretKeyRef?.key;

    validateSecretNamespace(accessIdSecretName!, accessIdSecretNamespace !== namespace ? accessIdSecretNamespace : undefined, namespace, `BackupSchedule "${name}" accessId`);
    validateSecretNamespace(accessKeySecretName!, accessKeySecretNamespace !== namespace ? accessKeySecretNamespace : undefined, namespace, `BackupSchedule "${name}" accessKey`);

    // Find ALL botmodules that reference this backupschedule
    type BotModuleTarget = {
      crName: string;
      moduleName: string;
      pvcName: string;
      pvcSpec: K8s.V1PersistentVolumeClaimSpec | undefined;
      volumeMountPath: string;
    };
    const targets: BotModuleTarget[] = [];

    try {
      const botModulesResponse = await customObjectsApi.listNamespacedCustomObject({
        group: eevee.BotModule.details.group,
        version: eevee.BotModule.details.version,
        namespace: namespace,
        plural: eevee.BotModule.details.plural,
      });

      const items = (botModulesResponse as { items: eevee.BotModule.BotModuleResource[] }).items;
      for (const bm of items) {
        if (bm.spec?.backupSchedule?.name === name) {
          const crName = bm.metadata?.name || "";
          targets.push({
            crName,
            moduleName: bm.spec.moduleName || crName,
            pvcName: `eevee-${crName}-module-pvc`,
            pvcSpec: bm.spec?.persistentVolumeClaim,
            volumeMountPath: bm.spec?.volumeMountPath || '/data',
          });
        }
      }
    } catch (error) {
      log.warn(`Failed to list botmodules for BackupSchedule "${name}":`, error);
    }

    if (targets.length === 0) {
      log.warn(
        `No botmodules reference BackupSchedule "${name}" — cannot determine backup targets`
      );
      await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'NoTargets',
            message: 'No botmodules reference this BackupSchedule',
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      }, true);
      return;
    }

    // Track which CronJob names we expect to exist after reconciliation
    const expectedCronJobNames = new Set<string>();

    // Create or update a CronJob for each botmodule target
    for (const target of targets) {
      const cronJobName = `${name}-${target.crName}-backup`;
      expectedCronJobNames.add(cronJobName);

      const envVars: K8s.V1EnvVar[] = [
        { name: 'S3_ENDPOINT', value: s3StoreSpec.endpoint },
        { name: 'S3_BUCKET', value: s3StoreSpec.bucket },
        { name: 'S3_PREFIX', value: s3StoreSpec.prefix || '' },
        { name: 'S3_PATH_STYLE', value: String(s3StoreSpec.pathStyle || false) },
        { name: 'S3_SIGNATURE_V2', value: String(s3StoreSpec.signatureV2 || false) },
        { name: 'BACKUP_NAMESPACE', value: namespace },
        { name: 'BACKUP_MODULE', value: target.moduleName },
        { name: 'BACKUP_PVC_PATH', value: target.volumeMountPath },
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
      if (target.pvcName) {
        volumes.push({
          name: 'module-data',
          persistentVolumeClaim: {
            claimName: target.pvcName,
          },
        });
        volumeMounts.push({
          name: 'module-data',
          mountPath: target.volumeMountPath,
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
              kind: eevee.BackupSchedule.details.name,
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
                      imagePullPolicy: spec.imagePullPolicy as K8s.V1Container['imagePullPolicy'] || 'IfNotPresent',
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
        log.debug(`CronJob ${cronJobName} already exists — patching`);
        await batchV1Api.patchNamespacedCronJob({
          name: cronJobName,
          namespace: namespace,
          body: cronJob,
        }, strategicMergePatchOptions);
        log.info(`Patched CronJob ${cronJobName} in namespace ${namespace}`);
      } catch {
        log.info(`Creating CronJob ${cronJobName} in namespace ${namespace}`);
        await batchV1Api.createNamespacedCronJob({
          namespace: namespace,
          body: cronJob,
        });
        log.info(`Created CronJob ${cronJobName} in namespace ${namespace}`);
      }
    } // end for (targets)

    // Clean up stale CronJobs for botmodules that no longer reference this schedule
    try {
      const cronJobsResponse = await batchV1Api.listNamespacedCronJob({
        namespace: namespace,
      });
      const cronJobs = cronJobsResponse.items || [];
      for (const cj of cronJobs) {
        const cjName = cj.metadata?.name || '';
        // Only consider CronJobs owned by this BackupSchedule
        const isOwned = cj.metadata?.ownerReferences?.some(
          (ref) => ref.uid === uid
        );
        if (isOwned && !expectedCronJobNames.has(cjName)) {
          log.info(
            `Deleting stale CronJob ${cjName} — botmodule no longer references BackupSchedule "${name}"`
          );
          try {
            await batchV1Api.deleteNamespacedCronJob({
              name: cjName,
              namespace: namespace,
            });
          } catch (error) {
            log.warn(`Failed to delete stale CronJob ${cjName}:`, error);
          }
        }
      }
    } catch (error) {
      log.warn(`Failed to list CronJobs for stale cleanup:`, error);
    }

    // Update the backupschedule status
    await updateBackupScheduleStatus(customObjectsApi, namespace, name, {
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'CronJobsCreated',
          message: `CronJobs created for ${targets.length} botmodule(s)`,
          lastTransitionTime: new Date().toISOString(),
        },
      ],
    }, true);

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
  status: Record<string, unknown>,
  terminal: boolean = false
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
    }, mergePatchOptions);

    if (terminal) {
      await setReconcileLast(customObjectsApi, namespace, name);
    }
  } catch (error) {
    log.error(
      `Failed to update status for BackupSchedule "${name}" in namespace "${namespace}":`,
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
      group: eevee.BackupSchedule.details.group,
      version: eevee.BackupSchedule.details.version,
      namespace: namespace,
      plural: eevee.BackupSchedule.details.plural,
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
}
