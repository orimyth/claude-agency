export { ceoBlueprint } from './ceo.js';
export { hrBlueprint } from './hr.js';
export { architectBlueprint } from './architect.js';
export { pmBlueprint } from './pm.js';
export { developerBlueprint } from './developer.js';
export { designerBlueprint } from './designer.js';
export { researcherBlueprint } from './researcher.js';

import { ceoBlueprint } from './ceo.js';
import { hrBlueprint } from './hr.js';
import { architectBlueprint } from './architect.js';
import { pmBlueprint } from './pm.js';
import { developerBlueprint } from './developer.js';
import { designerBlueprint } from './designer.js';
import { researcherBlueprint } from './researcher.js';
import type { AgentBlueprint } from '../../types.js';

export const defaultBlueprints: AgentBlueprint[] = [
  ceoBlueprint,
  hrBlueprint,
  architectBlueprint,
  pmBlueprint,
  developerBlueprint,
  designerBlueprint,
  researcherBlueprint,
];
