'use strict';

import { eevee } from '@eeveebot/crds';
import { ResourceEvent } from '@thehonker/k8s-operator';

import { log } from '../../lib/logging.mjs';
import { managedCrd } from '../../lib/managers/types.mjs';

export const managedCrds: managedCrd[] = [
  {
    group: eevee.ChatConnectionIrc.details.group,
    version: eevee.ChatConnectionIrc.details.version,
    plural: eevee.ChatConnectionIrc.details.plural,
    handler: handleResourceEvent,
  },
];

async function handleResourceEvent(event: ResourceEvent): Promise<void> {
  log.debug(event);
}
