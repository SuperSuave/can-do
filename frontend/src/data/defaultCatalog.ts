import { Catalog } from '../types/catalog';
import rawCatalog from '../../../catalog/can_do_catalog.json';

export const DEFAULT_CATALOG: Catalog = rawCatalog as unknown as Catalog;
