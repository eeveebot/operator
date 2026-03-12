'use strict';

import * as K8s from '@kubernetes/client-node';

import { default as Operator } from '@thehonker/k8s-operator';

// Critical
import { eeveeLogo } from './lib/logo.mjs';

// Logging
import { log, opLogger } from './lib/logging.mjs';

// Import managedCrd objects
import { managedCrd } from './lib/managers/types.mjs';

import { managedCrds as ChatConnectionIrc } from './lib/managers/eevee.bot.v1.ChatConnectionIrc.mjs';
import { managedCrds as IpcConfig } from './lib/managers/eevee.bot.v1.IpcConfig.mjs';
import { managedCrds as Toolbox } from './lib/managers/eevee.bot.v1.Toolbox.mjs';

const managedCrds: managedCrd[] = [];
managedCrds.push(...ChatConnectionIrc);
managedCrds.push(...IpcConfig);
managedCrds.push(...Toolbox);

// Get some runtime config from envvars
// Namespace the operator lives in
const NAMESPACE = process.env.NAMESPACE || 'eevee-bot';

// Should the operator only watch its own namespace for CRs
const WATCH_OTHER_NAMESPACES_ENV =
  process.env.WATCH_OTHER_NAMESPACES || 'false';
const WATCH_OTHER_NAMESPACES = parseBool(WATCH_OTHER_NAMESPACES_ENV);

// Setup some k8s stuff early
const kc = new K8s.KubeConfig();
kc.loadFromDefault();
const op = new Operator(kc, new opLogger());

// Signal handlers
process.on('SIGTERM', () => exit('SIGTERM'));
process.on('SIGINT', () => exit('SIGINT'));

// Start of logic
console.error(eeveeLogo);
log.info('eevee operator starting up...');

// Ensure CRDs are installed ahead of time
log.info('checking for crds');
if (!(await checkCRDs())) {
  log.error('crds not found! exiting...');
  await exit('crds not found', 1);
}

// Setup resource watchers so we know when CR objects change
await setupResourceWatchers();

// Run initial reconciliation for all resource types
await runInitialReconciliation();

/**
 * Cleanup before exit
 * Forces exit after 5 seconds if cleanup fails
 */
async function exit(reason: string, exitcode: number = 0) {
  log.info(`exiting due to ${reason}`);
  if (op) op.stop();
  process.exitCode = exitcode;
  setTimeout(() => {
    log.error('timeout expired, forcing exit');
    process.exit(exitcode != 0 ? exitcode : 127);
  }, 5000).unref();
}

/**
 * Ensure all our CRDs are installed in the cluster
 */
async function checkCRDs() {
  const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);
  const crds: K8s.V1APIResourceList[] = [];
  for (let i = 0; i < managedCrds.length; i++) {
    try {
      const found = await customObjectsApi.getAPIResources(managedCrds[i]);
      crds.push(found);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message.includes('404')) {
        return false;
      }
    }
  }
  if (crds.length === managedCrds.length) {
    return crds;
  } else {
    return false;
  }
}

/**
 * Setup resource watches in k8s api
 */
async function setupResourceWatchers() {
  managedCrds.forEach(async (crd: managedCrd) => {
    await op.watchResource(
      crd.group,
      crd.version,
      crd.plural,
      crd.handler,
      WATCH_OTHER_NAMESPACES ? NAMESPACE : undefined
    );
  });
}

/**
 * Run initial reconciliation for all resource types
 */
async function runInitialReconciliation() {
  log.info('running initial reconciliation for all resource types');
  for (const crd of managedCrds) {
    if (crd.reconciler) {
      try {
        await crd.reconciler(kc);
        log.info(`reconciliation completed for ${crd.plural}`);
      } catch (error) {
        log.error(`reconciliation failed for ${crd.plural}:`, error);
      }
    }
  }
}

function parseBool(value: string | undefined): boolean {
  if (value) {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return false;
}
