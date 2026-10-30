/** An unconfirmed process-tree shutdown must keep the execution lock for manual recovery. */
export function hasUncertainTermination(error: unknown): boolean {
  const seen = new Set<object>();
  function contains(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if ('kind' in value && value.kind === 'termination') return true;
    if ('cause' in value && contains(value.cause)) return true;
    return value instanceof AggregateError && value.errors.some(contains);
  }
  return contains(error);
}
