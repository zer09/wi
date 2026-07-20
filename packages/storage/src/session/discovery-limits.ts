export const DISCOVERY_ERROR_CODE_MAXIMUM_UNITS = 128;
export const DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS = 4_096;

export function boundDiscoveryDiagnostic(value: string, maximumUnits: number): string {
  if (value.length <= maximumUnits) return value;
  return `${value.slice(0, maximumUnits - 1)}…`;
}
