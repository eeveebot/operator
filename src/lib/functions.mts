'use strict';

import * as K8s from '@kubernetes/client-node';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { log } from './logging.mjs';

/**
 * Parse a string value to a boolean
 * @param value The string value to parse
 * @returns Boolean representation of the string value
 */
export function parseBool(value: string | undefined): boolean {
  if (value) {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return false;
}

/**
 * Resolve a secret key from a Kubernetes Secret.
 * Reads the named Secret, decodes the base64 value for the given key,
 * and returns the UTF-8 string.
 */
export async function resolveSecretKey(
  coreV1Api: K8s.CoreV1Api,
  fallbackNamespace: string,
  secretName: string,
  secretNamespace: string,
  key: string
): Promise<string | undefined> {
  try {
    const response = await coreV1Api.readNamespacedSecret({
      name: secretName,
      namespace: secretNamespace || fallbackNamespace,
    });

    const data = response.data;
    if (data && data[key]) {
      return Buffer.from(data[key], 'base64').toString('utf-8');
    }

    log.warn(`Key "${key}" not found in Secret "${secretName}"`);
    return undefined;
  } catch (error) {
    log.error(
      `Failed to read Secret "${secretName}" in namespace "${secretNamespace}":`,
      error
    );
    return undefined;
  }
}

/**
 * Find the latest backup UUID for a module by listing S3 objects
 * and selecting the most recent by LastModified timestamp.
 * Returns the UUID (filename without .tar.gz) or undefined.
 */
export async function findLatestBackup(
  endpoint: string,
  accessId: string,
  secretKey: string,
  bucket: string,
  prefix: string,
  namespace: string,
  moduleName: string,
  pathStyle: boolean
): Promise<string | undefined> {
  try {
    const client = new S3Client({
      endpoint: endpoint,
      credentials: {
        accessKeyId: accessId,
        secretAccessKey: secretKey,
      },
      forcePathStyle: pathStyle,
      region: 'us-east-1',
    });

    const s3Prefix = `${prefix}${namespace}/${moduleName}/`;
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: s3Prefix,
    });

    const response = await client.send(command);
    const objects = response.Contents;

    if (!objects || objects.length === 0) {
      return undefined;
    }

    // Sort by LastModified descending, pick the latest
    const sorted = objects
      .filter((obj) => obj.Key?.endsWith('.tar.gz'))
      .sort((a, b) => {
        const aTime = a.LastModified?.getTime() || 0;
        const bTime = b.LastModified?.getTime() || 0;
        return bTime - aTime;
      });

    if (sorted.length === 0) {
      return undefined;
    }

    // Extract UUID from the key: <prefix>/<namespace>/<moduleName>/<uuid>.tar.gz
    const latestKey = sorted[0].Key;
    if (!latestKey) {
      return undefined;
    }

    const parts = latestKey.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace('.tar.gz', '');
  } catch (error) {
    log.error(
      `Failed to list backups for module "${moduleName}" in bucket "${bucket}":`,
      error
    );
    return undefined;
  }
}
