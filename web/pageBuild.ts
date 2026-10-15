/** True when a bridge restarted on another build: this tab's page code is stale and safe to replace. */
export function staleBuild(known: string | undefined, incoming: string | undefined, dirty: boolean): boolean {
  return known !== undefined && incoming !== undefined && known !== incoming && !dirty;
}
