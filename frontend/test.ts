import { resolveCatalogCommandForAction } from './src/utils/automationConverters';
import fs from 'fs';
const catalog = JSON.parse(fs.readFileSync('../catalog/can_do_catalog.json', 'utf8'));
const act = {
  id: 'foo',
  type: 'transmit' as any,
  can_id: '0x4A2',
  bus: 0,
  payload: { D5: '0x5F' },
  repeat: 3
};
const res = resolveCatalogCommandForAction(act, catalog);
console.log('Matched Option:', res.matchedOption?.label);
