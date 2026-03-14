'use strict';

import * as K8s from '@kubernetes/client-node';
import express, { Application, Request, Response } from 'express';
import { default as Operator } from '@thehonker/k8s-operator';

// Critical
import { eeveeLogo } from './lib/logo.mjs';

// Logging
import { log, opLogger } from './lib/logging.mjs';

// Import managedCrd objects
import { managedCrd } from './lib/managers/types.mjs';

// Import utility functions
import { parseBool } from './lib/functions.mjs';

// Import API routes
import apiRoutes from './api/routes.mjs';

// Import metrics
import { k8sActiveWatches } from './lib/metrics.mjs';

import { managedCrds as IpcConfig } from './lib/managers/eevee.bot.v1.IpcConfig.mjs';
import { managedCrds as BotModule } from './lib/managers/eevee.bot.v1.BotModule.mjs';

const managedCrds: managedCrd[] = [];
managedCrds.push(...IpcConfig);
managedCrds.push(...BotModule);

// Get some runtime config from envvars
// Namespace the operator lives in
const NAMESPACE = process.env.NAMESPACE || 'eevee-bot';

// Should the operator only watch its own namespace for CRs
const WATCH_OTHER_NAMESPACES_ENV =
  process.env.WATCH_OTHER_NAMESPACES || 'false';
const WATCH_OTHER_NAMESPACES = parseBool(WATCH_OTHER_NAMESPACES_ENV);

// Setup some k8s stuff early
const kc = new K8s.KubeConfig();
const KUBE_IN_CLUSTER_CONFIG = parseBool(process.env.KUBE_IN_CLUSTER_CONFIG);
if (KUBE_IN_CLUSTER_CONFIG) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}
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

// Setup HTTP API server
setupHttpServer();

/**
 * Setup HTTP API server
 */
function setupHttpServer() {
  const app: Application = express();
  const port = process.env.HTTP_API_PORT || '9000';

  // Middleware
  app.use(express.json());

  // API routes
  app.use('/api', apiRoutes);

  // Root endpoint
  app.get('/', (req: Request, res: Response) => {
    res.status(200).json({
      message: 'eevee.bot Operator API',
      timestamp: new Date().toISOString(),
    });
  });

  // Start server
  const server = app.listen(port, () => {
    log.info(`HTTP API server listening on port ${port}`);
  });

  // Handle server errors
  server.on('error', (err) => {
    log.error('HTTP API server error', err);
  });
}

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
  let activeWatches = 0;
  
  for (const crd of managedCrds) {
    await op.watchResource(
      crd.group,
      crd.version,
      crd.plural,
      crd.handler,
      WATCH_OTHER_NAMESPACES ? undefined : NAMESPACE
    );
    activeWatches++;
    k8sActiveWatches.set(activeWatches);
  }
}
