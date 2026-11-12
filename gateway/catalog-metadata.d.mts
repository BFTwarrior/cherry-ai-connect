export type CatalogEntry = { id: string; kind: 'category' | 'model-category' | 'route-protocol' | 'model-protocol'; providerId: string; model: string; value: string | string[] | null; deleted: boolean; revision: {counter: number; deviceId: string} };
export type Category = { id: string; name: string };
export const BUILTIN_CATEGORIES: readonly Category[];
export const PROTOCOLS: readonly string[];
export const PROTOCOL_OPTIONS: readonly { value: string; label: string }[];
export function metadataId(kind: string, providerId?: string, model?: string): string;
export function inferModelCategories(model: string): string[];
export function mergeCatalogMetadata(local?: CatalogEntry[], remote?: CatalogEntry[]): CatalogEntry[];
export function catalogCategories(records?: CatalogEntry[]): Category[];
export function modelCategories(records: CatalogEntry[], providerId: string, model: string): string[];
export function routeCategories(records: CatalogEntry[], provider: {id: string; models: string[]; catalogModels?: string[]}): string[];
export function upstreamProtocol(records: CatalogEntry[], providerId: string, model?: string): string;
export function catalogMutation(records: CatalogEntry[], data: {kind: string; providerId?: string; model?: string; value?: string | string[] | null; deleted?: boolean}, revision: {counter: number; deviceId: string}): CatalogEntry[];

export function retireModelProtocols(records: CatalogEntry[], revision: {counter: number; deviceId: string}): CatalogEntry[];
