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
    group: eevee.BackupRestore.details.group,
    version: eevee.BackupRestore.details.version,
    plural: eevee.BackupRestore.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug('Received BackupRestore resource event:', event);

  // Track Kubernetes resource events
  k8sResourceEventsTotal.inc({
    resource_type: 'BackupRestore',
    event_type: event.type,
  });

  switch (event.type) {
    case ResourceEventType.Added:
      log.info(
        `BackupRestore resource added: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for added BackupRestore resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Modified:
      log.info(
        `BackupRestore resource modified: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      try {
        await reconcileResource(kc, event);
        log.debug('Reconciliation completed for modified BackupRestore resource');
      } catch (error) {
        log.error('Error during reconciliation:', error);
      }
      break;
    case ResourceEventType.Deleted:
      log.info(
        `BackupRestore resource deleted: ${event.meta.name} in namespace ${event.meta.namespace || 'unknown'}`
      );
      // Job is owned by the backuprestore via ownerReference,
      // so K8s GC handles cleanup automatically.
      break;
  }
}

async function reconcileResource(
  kc: K8s.KubeConfig,
  event: ResourceEvent
): Promise<void> {
  log.debug('Starting backuprestore reconciliation for specific resource');
  if (!kc) {
    log.error('KubeConfig not provided to backuprestore reconciler');
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
      `Processing BackupRestore resource ${resourceName} in namespace ${resourceNamespace}`
    );

    // Get the BackupRestore resource
    const restoreResponse = await customObjectsApi.getNamespacedCustomObject({
      group: eevee.BackupRestore.details.group,
      version: eevee.BackupRestore.details.version,
      namespace: resourceNamespace,
      plural: eevee.BackupRestore.details.plural,
      name: resourceName,
    });

    if (!restoreResponse) {
      log.error(
        `Failed to retrieve BackupRestore resource ${resourceName} in namespace ${resourceNamespace}`
      );
      return;
    }

    const item = restoreResponse as eevee.BackupRestore.BackupRestoreResource;
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;
    const uid = item.metadata?.uid;

    if (!namespace || !name || !uid) {
      log.debug('Skipping BackupRestore resource with missing namespace, name, or uid');
      return;
    }

    const spec = item.spec;
    if (!spec?.botModule || !spec?.s3Store || !spec?.image) {
      log.warn(`BackupRestore "${name}" is missing required spec fields`);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'InvalidSpec',
            message: 'Missing required spec fields (botModule, s3Store, image)',
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      }, true);
      return;
    }

    // If status is already terminal (Ready=True or Ready=False), skip reconciliation
    const currentConditions = (item.status as unknown as { conditions?: { type: string; status: string; reason: string; message?: string }[] })?.conditions;
    const readyCondition = currentConditions?.find(c => c.type === 'Ready');
    if (readyCondition && readyCondition.status !== 'Unknown') {
      log.debug(`BackupRestore "${name}" is in terminal state (${readyCondition.status}/${readyCondition.reason}) — skipping`);
      return;
    }

    // If a Job already exists, check its status
    const jobName = `${name}-restore`;

    try {
      const job = await batchV1Api.readNamespacedJob({
        name: jobName,
        namespace: namespace,
      });


      // Check job completion
      if (job.status?.succeeded) {
        log.info(`Restore Job "${jobName}" succeeded`);

        // Set the bootstrapped annotation on the PVC — a restore is
        // equivalent to a bootstrap. backuprestore ignores the annotation
        // (it always runs), but on success we mark the PVC as populated
        // so future bootstrapFromBackup checks skip correctly.
        const pvcName = `eevee-${spec.botModule.name}-module-pvc`;
        await ensureRestorePvcBootstrapped(coreV1Api, namespace, pvcName);

        await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
          conditions: [{
            type: 'Ready',
            status: 'True',
            reason: 'Succeeded',
            message: `Restore Job ${jobName} succeeded`,
            lastTransitionTime: new Date().toISOString(),
          }],
        }, true);
        return;
      }

      if (job.status?.failed) {
        log.warn(`Restore Job "${jobName}" failed`);
        await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'Failed',
            message: `Restore Job ${jobName} failed`,
            lastTransitionTime: new Date().toISOString(),
          }],
        }, true);
        return;
      }

      // Job is still running
      log.debug(`Restore Job "${jobName}" is still running`);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'Unknown',
          reason: 'Running',
          message: `Restore Job ${jobName} in progress`,
          lastTransitionTime: new Date().toISOString(),
        }],
      });
      return;
    } catch {
      // Job doesn't exist yet
    }

    // Resolve the botmodule reference
    const botModuleName = spec.botModule.name;
    log.debug(`Resolving botmodule "${botModuleName}" for BackupRestore "${name}"`);

    let moduleName: string | undefined;
    let pvcName: string | undefined;
    let volumeMountPath = '/data';

    try {
      const botModuleResponse = await customObjectsApi.getNamespacedCustomObject({
        group: eevee.BotModule.details.group,
        version: eevee.BotModule.details.version,
        namespace: namespace,
        plural: eevee.BotModule.details.plural,
        name: botModuleName,
      });
      const botModuleItem = botModuleResponse as eevee.BotModule.BotModuleResource;
      moduleName = botModuleItem.spec?.moduleName || botModuleItem.metadata?.name;
      volumeMountPath = botModuleItem.spec?.volumeMountPath || '/data';
      pvcName = `eevee-${botModuleItem.metadata?.name}-module-pvc`;
    } catch (error) {
      log.warn(`Failed to resolve botmodule "${botModuleName}" for BackupRestore "${name}":`, error);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'BotModuleNotFound',
          message: `Failed to resolve botmodule "${botModuleName}"`,
          lastTransitionTime: new Date().toISOString(),
        }],
      }, true);
      return;
    }

    if (!moduleName) {
      log.warn(`botmodule "${botModuleName}" has no moduleName`);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'BotModuleInvalid',
          message: `botmodule "${botModuleName}" has no moduleName`,
          lastTransitionTime: new Date().toISOString(),
        }],
      }, true);
      return;
    }

    // Resolve the s3store reference
    const s3StoreName = spec.s3Store.name;
    log.debug(`Resolving s3store "${s3StoreName}" for BackupRestore "${name}"`);

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
        log.warn(`S3Store "${s3StoreName}" is not ready (${reason}) for BackupRestore "${name}"`);
        await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
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
      log.warn(`Failed to resolve s3store "${s3StoreName}" for BackupRestore "${name}":`, error);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'S3StoreNotFound',
          message: `Failed to resolve s3store "${s3StoreName}"`,
          lastTransitionTime: new Date().toISOString(),
        }],
      }, true);
      return;
    }

    if (!s3StoreSpec) {
      log.warn(`s3store "${s3StoreName}" has no spec`);
      await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'S3StoreInvalid',
          message: `s3store "${s3StoreName}" has no spec`,
          lastTransitionTime: new Date().toISOString(),
        }],
      }, true);
      return;
    }

    // Determine the backup UUID to restore
    let backupId = spec.backupId;

    if (!backupId) {
      // Find the latest backup by listing S3 objects
      log.info(`No backupId specified — finding latest backup for module "${moduleName}"`);

      validateSecretNamespace(
        s3StoreSpec.accessId?.secretKeyRef?.secret?.name || "",
        s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace,
        namespace,
        `BackupRestore "${name}" accessId`
      );
      const accessId = await resolveSecretKey(
        coreV1Api,
        namespace,
        s3StoreSpec.accessId?.secretKeyRef?.secret?.name || "",
        s3StoreSpec.accessId?.secretKeyRef?.secret?.namespace || namespace,
        s3StoreSpec.accessId?.secretKeyRef?.key || ""
      );

      validateSecretNamespace(
        s3StoreSpec.accessKey?.secretKeyRef?.secret?.name || "",
        s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace,
        namespace,
        `BackupRestore "${name}" accessKey`
      );
      const secretKey = await resolveSecretKey(
        coreV1Api,
        namespace,
        s3StoreSpec.accessKey?.secretKeyRef?.secret?.name || "",
        s3StoreSpec.accessKey?.secretKeyRef?.secret?.namespace || namespace,
        s3StoreSpec.accessKey?.secretKeyRef?.key || ""
      );

      if (!accessId || !secretKey) {
        log.warn(`Cannot resolve S3 credentials to list backups for BackupRestore "${name}"`);
        await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'SecretNotFound',
            message: 'Failed to resolve S3 credentials from Secrets',
            lastTransitionTime: new Date().toISOString(),
          }],
        }, true);
        return;
      }

      backupId = await findLatestBackup(
        s3StoreSpec.endpoint,
        accessId,
        secretKey,
        s3StoreSpec.bucket,
        s3StoreSpec.prefix || '',
        namespace,
        moduleName,
        s3StoreSpec.pathStyle || false,
        s3StoreSpec.region
      );

      if (!backupId) {
        log.warn(`No backups found for module "${moduleName}" in s3store "${s3StoreName}"`);
        await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'NoBackupsFound',
            message: `No backups found for module "${moduleName}" in s3store "${s3StoreName}"`,
            lastTransitionTime: new Date().toISOString(),
          }],
        }, true);
        return;
      }

      log.info(`Found latest backup: ${backupId}`);
    }

    // Resolve S3 credential secret references for env injection
    const accessIdSecretName = s3StoreSpec.accessId?.secretKeyRef?.secret?.name;
    const accessIdSecretKey = s3StoreSpec.accessId?.secretKeyRef?.key || "";
    const accessKeySecretName = s3StoreSpec.accessKey?.secretKeyRef?.secret?.name;
    const accessKeySecretKey = s3StoreSpec.accessKey?.secretKeyRef?.key || "";

    // Build the Job
    const envVars: K8s.V1EnvVar[] = [
      { name: 'S3_ENDPOINT', value: s3StoreSpec.endpoint },
      { name: 'S3_BUCKET', value: s3StoreSpec.bucket },
      { name: 'S3_PREFIX', value: s3StoreSpec.prefix || '' },
      { name: 'S3_PATH_STYLE', value: String(s3StoreSpec.pathStyle || false) },
      { name: 'S3_SIGNATURE_V2', value: String(s3StoreSpec.signatureV2 || false) },
      { name: 'RESTORE_NAMESPACE', value: namespace },
      { name: 'RESTORE_MODULE', value: moduleName },
      { name: 'RESTORE_BACKUP_ID', value: backupId },
      { name: 'BACKUP_PVC_PATH', value: volumeMountPath },
      { name: 'RESTORE_CLEAN', value: String(spec.cleanRestore || false) },
    ];

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

    // Mount the botmodule's PVC (read-write for restore)
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
      });
    }

    const job: K8s.V1Job = {
      metadata: {
        name: jobName,
        namespace: namespace,
        ownerReferences: [
          {
            apiVersion: `${eevee.BackupRestore.details.group}/${eevee.BackupRestore.details.version}`,
            kind: eevee.BackupRestore.details.name,
            name: name,
            uid: uid,
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
                image: spec.image,
                imagePullPolicy: spec.imagePullPolicy as K8s.V1Container['imagePullPolicy'] || 'IfNotPresent',
                command: ['/usr/local/bin/restore.sh'],
                env: envVars,
                volumeMounts: volumeMounts,
              },
            ],
          },
        },
      },
    };

    log.info(`Creating restore Job ${jobName} in namespace ${namespace}`);
    await batchV1Api.createNamespacedJob({
      namespace: namespace,
      body: job,
    });

    await updateBackupRestoreStatus(customObjectsApi, namespace, name, {
      conditions: [{
        type: 'Ready',
        status: 'Unknown',
        reason: 'Pending',
        message: `Restore Job ${jobName} created for backup ${backupId}`,
        lastTransitionTime: new Date().toISOString(),
      }],
    });

    log.debug('BackupRestore reconciliation completed successfully');
  } catch (error) {
    log.error('Error during backuprestore reconciliation:', error);
  }
}




/**
 * Update the status subresource of a BackupRestore CR.
 */
async function updateBackupRestoreStatus(
  customObjectsApi: K8s.CustomObjectsApi,
  namespace: string,
  name: string,
  status: Record<string, unknown>,
  terminal: boolean = false
): Promise<void> {
  try {
    await customObjectsApi.patchNamespacedCustomObjectStatus({
      group: eevee.BackupRestore.details.group,
      version: eevee.BackupRestore.details.version,
      namespace: namespace,
      plural: eevee.BackupRestore.details.plural,
      name: name,
      body: {
        status: status,
      },
    });

    if (terminal) {
      await setReconcileLast(customObjectsApi, namespace, name);
    }
  } catch (error) {
    log.error(
      `Failed to update status for BackupRestore "${name}" in namespace "${namespace}":`,
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
      group: eevee.BackupRestore.details.group,
      version: eevee.BackupRestore.details.version,
      namespace: namespace,
      plural: eevee.BackupRestore.details.plural,
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
 * Set the eevee.bot/bootstrapped annotation on a PVC after a successful restore.
 * A restore is equivalent to a bootstrap — the PVC is now populated.
 */
async function ensureRestorePvcBootstrapped(
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
    log.debug(`Set bootstrapped annotation on PVC ${pvcName} after restore`);
  } catch (error) {
    log.debug(
      `Could not set bootstrapped annotation on PVC ${pvcName}:`,
      error
    );
  }
}
