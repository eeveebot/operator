'use strict';

/**
 * Parse a string value to a boolean
 * @param value The string value to parse
 * @returns Boolean representation of the string value
 */
export function parseBool(value: string | undefined): boolean {
  if (value) {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return false;
}
