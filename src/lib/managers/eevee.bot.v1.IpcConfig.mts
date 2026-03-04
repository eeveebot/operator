'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent } from '@thehonker/k8s-operator';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';

export const managedCrds: managedCrd[] = [
  {
    group: eevee.IpcConfig.details.group,
    version: eevee.IpcConfig.details.version,
    plural: eevee.IpcConfig.details.plural,
    handler: handleResourceEvent,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(event);
}
