'use strict';

import {
  ResourceEvent,
} from '@thehonker/k8s-operator';

export interface managedCrd {
  group: string;
  version: string;
  plural: string;
  handler: (event: ResourceEvent) => Promise<void>;
}
