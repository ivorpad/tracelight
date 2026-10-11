/** The value commands of the palette and the editor menus (Show Value, Auto Log, copy, hover links, package install), registered by extension.ts. */
import type { LiveValues } from './liveValues';
import type { PackageInstall } from './packageInstall';

export function registerValueCommands(reg: (id: string, fn: (...args: unknown[]) => unknown) => void, liveValues: LiveValues, packages: PackageInstall): void {
  reg('tracelight.showValue', () => liveValues.showValue());
  reg('tracelight.showLineValues', () => liveValues.showLineValues());
  reg('tracelight.showLineTimings', () => liveValues.showLineTimings());
  reg('tracelight.copyValue', () => liveValues.copyValue());
  reg('tracelight.clearValue', () => liveValues.clearValue());
  reg('tracelight.clearFileValues', () => liveValues.clearFileValues());
  reg('tracelight.enableShowValueOnSelection', () => liveValues.setShowValueOnSelection(true));
  reg('tracelight.disableShowValueOnSelection', () => liveValues.setShowValueOnSelection(false));
  reg('tracelight.enableShowSingleInlineValue', () => liveValues.setShowSingleInlineValue(true));
  reg('tracelight.disableShowSingleInlineValue', () => liveValues.setShowSingleInlineValue(false));
  reg('tracelight.enableAutoLog', () => liveValues.setAutoLog(true));
  reg('tracelight.disableAutoLog', () => liveValues.setAutoLog(false));
  reg('tracelight.copyExpressionPath', (arg) => liveValues.copyExpressionPath(arg));
  reg('tracelight.copyExpressionData', (arg) => liveValues.copyExpressionData(arg));
  reg('tracelight.hoverCopy', (arg) => liveValues.hoverCopy(arg));
  reg('tracelight.exploreEntity', (arg) => liveValues.exploreEntity(arg));
  reg('tracelight.installMissingPackageToProject', (arg) => packages.installToProject(arg));
  reg('tracelight.installMissingPackageForFile', (arg) => packages.installForFile(arg));
}
