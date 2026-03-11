'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent } from '@thehonker/k8s-operator';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';

export const managedCrds: managedCrd[] = [
  {
    group: eevee.Toolbox.details.group,
    version: eevee.Toolbox.details.version,
    plural: eevee.Toolbox.details.plural,
    handler: handleResourceEvent,
    reconciler: reconcileResource,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(event);
}

async function reconcileResource(): Promise<void> {
  log.debug('reconcileResource in ipcconfig called');
}
