import type { ProductOption } from '@pod-studio/db';

export const CATALOG_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;
export interface CatalogIssue {
  row?: number;
  field: string;
  message: string;
}
export class CatalogError extends Error {
  override readonly name = 'CatalogError';
  constructor(
    readonly code: 'INVALID_CATALOG' | 'CATALOG_CONFLICT',
    readonly issues: CatalogIssue[] = [],
  ) {
    super(
      code === 'CATALOG_CONFLICT'
        ? 'The catalog changed. Reload before saving again.'
        : issues.map((issue) => issue.message).join(' '),
    );
  }
}
export interface ProductTypeInput {
  name: string;
  currency: string;
  options: ProductOption[];
}
export interface PriceRowInput {
  id?: string;
  optionValues: Record<string, string>;
  price: string;
  excludedMarkets: string[];
}
export interface PriceTableInput {
  revision: number;
  rows: PriceRowInput[];
}

export function invalid(field: string, message: string): never {
  throw new CatalogError('INVALID_CATALOG', [{ field, message }]);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Prices are exact integer cents; no parseFloat, multiplication of decimal floats or rounding. */
export function parsePrice(value: string): number {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim()))
    invalid('price', 'Price must be a non-negative amount with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > 2147483647n) invalid('price', 'Price exceeds the supported maximum of 21474836.47.');
  return Number(minor);
}
export function formatPrice(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0 || minor > 2147483647) invalid('price', 'Invalid minor-unit amount.');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function validateProductType(input: ProductTypeInput): ProductTypeInput {
  if (!object(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)
    invalid('name', 'Product type name is required (up to 100 characters).');
  if (!CATALOG_CURRENCIES.some((currency) => currency === input.currency))
    invalid('currency', 'Choose a supported two-decimal currency.');
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 3)
    invalid('options', 'Define one to three required options.');
  const names = new Set<string>();
  const options = input.options.map((option) => {
    if (!object(option) || typeof option.name !== 'string' || !option.name.trim() || option.name.trim().length > 50)
      invalid('options', 'Each option needs a name (up to 50 characters).');
    const name = option.name.trim();
    if (['__proto__', 'constructor', 'prototype'].includes(name) || names.has(name.toLowerCase()))
      invalid('options', 'Option names must be unique.');
    names.add(name.toLowerCase());
    if (
      !Array.isArray(option.values) ||
      !option.values.length ||
      option.values.length > 100 ||
      option.values.some((value) => typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    )
      invalid('options', `${name} needs 1 to 100 non-empty values.`);
    const values = option.values.map((value) => value.trim());
    if (new Set(values.map((value) => value.toLowerCase())).size !== values.length)
      invalid('options', `${name} values must be unique.`);
    return { name, values };
  });
  return { name: input.name.trim(), currency: input.currency, options };
}

export function validateRows(options: ProductOption[], rows: PriceRowInput[]) {
  if (!Array.isArray(rows) || rows.length > 500) invalid('rows', 'A price table supports up to 500 rows.');
  const issues: CatalogIssue[] = [];
  const combinations = new Set<string>();
  const ids = new Set<string>();
  const validated = rows.map((row, index) => {
    const issue = (field: string, message: string) =>
      issues.push({
        row: index,
        field,
        message: `Row ${index + 1}: ${message}`,
      });
    if (!object(row)) {
      issue('row', 'Invalid row.');
      return null;
    }
    if (row.id !== undefined && (typeof row.id !== 'string' || ids.has(row.id)))
      issue('id', 'Invalid or duplicate row identity.');
    if (row.id) ids.add(row.id);
    const values: Record<string, string> = {};
    for (const option of options) {
      const value = object(row.optionValues) ? row.optionValues[option.name] : undefined;
      if (typeof value !== 'string' || !value) issue(option.name, `${option.name} is required.`);
      else if (!option.values.includes(value))
        issue(option.name, `${option.name} must be one of its configured values.`);
      else values[option.name] = value;
    }
    if (
      object(row.optionValues) &&
      Object.keys(row.optionValues).some((key) => !options.some((option) => option.name === key))
    )
      issue('options', 'Unknown option in this row.');
    const combination = JSON.stringify(options.map((option) => values[option.name]));
    if (combinations.has(combination)) issue('options', 'This option combination is already in the table.');
    combinations.add(combination);
    let priceMinor = 0;
    try {
      priceMinor = parsePrice(row.price);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      issue('price', error.message);
    }
    if (
      !Array.isArray(row.excludedMarkets) ||
      row.excludedMarkets.length > 250 ||
      row.excludedMarkets.some((market) => typeof market !== 'string' || !/^[A-Z]{2}$/.test(market))
    )
      issue('excludedMarkets', 'Excluded markets must be two-letter uppercase country codes.');
    const excludedMarkets = Array.isArray(row.excludedMarkets) ? [...new Set(row.excludedMarkets)] : [];
    return {
      id: row.id,
      optionValues: values,
      priceMinor,
      excludedMarkets,
      sortOrder: index,
    };
  });
  if (issues.length) throw new CatalogError('INVALID_CATALOG', issues);
  return validated as Array<{
    id?: string;
    optionValues: Record<string, string>;
    priceMinor: number;
    excludedMarkets: string[];
    sortOrder: number;
  }>;
}
