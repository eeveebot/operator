'use strict';

import * as K8s from '@kubernetes/client-node';
import { setHeaderOptions } from '@kubernetes/client-node';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { log } from './logging.mjs';

/**
 * Create a configured S3Client instance.
 * Centralizes S3 client construction so credentials, region, and pathStyle
 * handling are consistent across the operator.
 */
export function createS3Client(
  endpoint: string,
  accessId: string,
  secretKey: string,
  pathStyle: boolean,
  region?: string
): S3Client {
  return new S3Client({
    endpoint,
    credentials: {
      accessKeyId: accessId,
      secretAccessKey: secretKey,
    },
    forcePathStyle: pathStyle,
    region: region || 'us-east-1',
  });
}

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
  pathStyle: boolean,
  region?: string
): Promise<string | undefined> {
  try {
    const client = createS3Client(endpoint, accessId, secretKey, pathStyle, region);

    const s3Prefix = `${prefix}${namespace}/${moduleName}/`;
    const allObjects: { Key?: string; LastModified?: Date }[] = [];

    // Paginate through all objects — S3 returns up to 1000 keys per request
    let continuationToken: string | undefined;
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: s3Prefix,
        ContinuationToken: continuationToken,
      });

      const response = await client.send(command);
      if (response.Contents) {
        allObjects.push(...response.Contents);
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    if (allObjects.length === 0) {
      return undefined;
    }

    // Sort by LastModified descending, pick the latest
    const sorted = allObjects
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

/**
 * ConfigurationOptions for strategic-merge-patch (built-in K8s resources).
 * The @kubernetes/client-node v1.x defaults to application/json-patch+json
 * which requires an array body; our patch calls use merge-patch objects.
 */
export const strategicMergePatchOptions = setHeaderOptions(
  'Content-Type',
  'application/strategic-merge-patch+json'
);

/**
 * ConfigurationOptions for merge-patch+json (CRs / status subresources).
 * Custom resources do not support strategic merge — use standard merge-patch.
 */
export const mergePatchOptions = setHeaderOptions(
  'Content-Type',
  'application/merge-patch+json'
);

/**
 * Validate that a cross-namespace secret reference is not trying to escape
 * the CR's namespace. All resources must live in the same namespace.
 * Throws if namespace is provided and doesn't match the expected namespace.
 */
export function validateSecretNamespace(
  secretName: string,
  secretNamespace: string | undefined,
  expectedNamespace: string,
  context: string
): void {
  if (secretNamespace && secretNamespace !== expectedNamespace) {
    throw new Error(
      `${context}: secret "${secretName}" is in namespace "${secretNamespace}" but must be in "${expectedNamespace}". Cross-namespace secrets are not supported.`
    );
  }
}
