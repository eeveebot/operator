'use strict';

import { Router, Request, Response, NextFunction } from 'express';
import * as K8s from '@kubernetes/client-node';
import { log } from '../lib/logging.mjs';
import { parseBool } from '../lib/functions.mjs';
import {
  register,
  apiRequestsTotal,
  apiRequestDurationSeconds,
  moduleRestartsTotal,
} from '../lib/metrics.mjs';

// Setup Kubernetes client
const kc = new K8s.KubeConfig();
const KUBE_IN_CLUSTER_CONFIG = parseBool(process.env.KUBE_IN_CLUSTER_CONFIG);
if (KUBE_IN_CLUSTER_CONFIG) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}

const router = Router();

// Metrics endpoint (no authentication required)
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    log.error('Error generating metrics:', error);
    res.status(500).end();
  }
});

// Authentication middleware
const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = process.env.EEVEE_OPERATOR_API_TOKEN;

  // If no token is configured, allow all requests (dev mode)
  if (!token) {
    log.warn('No EEVEE_OPERATOR_API_TOKEN configured - API disabled');
    return res.status(401).json({ error: 'API Token not configured' });
  }

  // Check if authorization header exists
  if (!authHeader) {
    log.warn('Authorization header missing from request');
    return res.status(401).json({ error: 'Authorization header required' });
  }

  // Check if it's Bearer token format
  const tokenParts = authHeader.split(' ');
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    log.warn('Invalid authorization header format');
    return res.status(401).json({ error: 'Invalid authorization format' });
  }

  // Check if token matches
  if (tokenParts[1] !== token) {
    log.warn('Invalid API token provided');
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Token is valid, proceed
  next();
};

// Apply authentication middleware to all routes except metrics
router.use((req: Request, res: Response, next: NextFunction) => {
  // Skip authentication for metrics endpoint
  if (req.path === '/metrics') {
    return next();
  }
  authenticateToken(req, res, next);
});

// Request tracking middleware
router.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  // Track response finish to record metrics
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000; // Convert to seconds

    // Record request duration
    apiRequestDurationSeconds.observe(
      {
        method: req.method,
        route: req.route?.path || req.path,
      },
      duration
    );

    // Record request count
    apiRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode.toString(),
    });
  });

  next();
});

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get bot modules endpoint - returns list of botModules and their image/tag
router.get('/bot-modules', async (req: Request, res: Response) => {
  try {
    // Get namespace from environment variable
    const NAMESPACE = process.env.NAMESPACE || 'eevee-bot';

    // Get CustomObjectsApi client
    const customObjectsApi = kc.makeApiClient(K8s.CustomObjectsApi);

    // Get all BotModule resources in the operator's namespace
    const botModulesResponse =
      await customObjectsApi.listNamespacedCustomObject({
        group: 'eevee.bot',
        version: 'v1',
        namespace: NAMESPACE,
        plural: 'botmodules',
      });

    // Extract the items from the response
    const botModules = (botModulesResponse.body as any).items || [];

    // Map to simplified structure with module name and image info
    const moduleInfo = botModules.map((module: any) => {
      const moduleName = module.metadata?.name;
      const namespace = module.metadata?.namespace;
      const image = module.spec?.image || 'unknown';

      // Extract tag from image (everything after the last colon)
      const tag = image.includes(':') ? image.split(':').pop() : 'unknown';

      return {
        name: moduleName,
        namespace: namespace,
        image: image,
        tag: tag,
        enabled:
          module.spec?.enabled !== undefined ? module.spec.enabled : true,
      };
    });

    res.status(200).json(moduleInfo);
  } catch (error: any) {
    log.error('Error fetching bot modules:', error);
    res.status(500).json({
      error: 'Failed to fetch bot modules',
      details: error.message,
    });
  }
});

// Restart module endpoint - performs rollout restart of a botModule-driven deployment
router.post('/action/restart-module', async (req: Request, res: Response) => {
  try {
    const { moduleName, namespace } = req.body;

    if (!moduleName) {
      return res.status(400).json({ error: 'moduleName is required' });
    }

    if (!namespace) {
      return res.status(400).json({ error: 'namespace is required' });
    }

    log.info(
      `Restart module action triggered for ${moduleName} in namespace ${namespace}`
    );

    // Generate deployment name based on botmodule name (following the same pattern as in BotModule manager)
    const deploymentName = `eevee-${moduleName}-module`;

    // Get AppsV1Api client
    const appsV1Api = kc.makeApiClient(K8s.AppsV1Api);

    // Patch the deployment with a restart annotation using JSON Patch format
    const patch = [
      {
        op: 'add',
        path: '/spec/template/metadata/annotations',
        value: {
          'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
        },
      },
    ];

    try {
      await appsV1Api.patchNamespacedDeployment({
        name: deploymentName,
        namespace: namespace,
        body: patch,
      });

      // Track successful module restart
      moduleRestartsTotal.inc({
        module_name: moduleName,
        namespace: namespace,
        success: 'true',
      });
    } catch (error: any) {
      if (error.response && error.response.statusCode === 404) {
        log.warn(
          `Deployment ${deploymentName} not found in namespace ${namespace}`
        );

        // Track failed module restart
        moduleRestartsTotal.inc({
          module_name: moduleName,
          namespace: namespace,
          success: 'false',
        });

        return res.status(404).json({
          error: `Deployment for module ${moduleName} not found in namespace ${namespace}`,
        });
      }

      log.error(
        `Failed to restart deployment ${deploymentName} in namespace ${namespace}:`,
        error
      );

      // Track failed module restart
      moduleRestartsTotal.inc({
        module_name: moduleName,
        namespace: namespace,
        success: 'false',
      });

      return res.status(500).json({
        error: `Failed to restart module ${moduleName}`,
        details: error.message,
      });
    }
  } catch (error: any) {
    log.error('Error processing restart-module request:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    });
  }

  // Return success response
  return res.status(200).json({
    message: `Module ${req.body.moduleName} restart initiated successfully`,
  });
});

export default router;
