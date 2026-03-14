'use strict';

import { Router, Request, Response, NextFunction } from 'express';
import * as K8s from '@kubernetes/client-node';
import { log } from '../lib/logging.mjs';
import { parseBool } from '../lib/functions.mjs';

// Setup Kubernetes client
const kc = new K8s.KubeConfig();
const KUBE_IN_CLUSTER_CONFIG = parseBool(process.env.KUBE_IN_CLUSTER_CONFIG);
if (KUBE_IN_CLUSTER_CONFIG) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}

const router = Router();

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

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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
    } catch (error: any) {
      if (error.response && error.response.statusCode === 404) {
        log.warn(
          `Deployment ${deploymentName} not found in namespace ${namespace}`
        );
        return res.status(404).json({
          error: `Deployment for module ${moduleName} not found in namespace ${namespace}`,
        });
      }

      log.error(
        `Failed to restart deployment ${deploymentName} in namespace ${namespace}:`,
        error
      );
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
