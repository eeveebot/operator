'use strict';

import { ResourceEvent } from '@thehonker/k8s-operator';

import * as K8s from '@kubernetes/client-node';

export interface managedCrd {
  group: string;
  version: string;
  plural: string;
  handler: (event: ResourceEvent) => Promise<void>;
  reconciler?: (kc?: K8s.KubeConfig) => Promise<void>;
}
