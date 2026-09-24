// Desktop development only: emulates a Quest 3 with hands and a scanned room
// (planes with semantic labels, passthrough video). Loaded on demand from main.ts.
import { XRDevice, metaQuest3 } from 'iwer';
import { DevUI } from '@iwer/devui';
import { SyntheticEnvironmentModule } from '@iwer/sem';

export async function installEmulator(params: URLSearchParams) {
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  device.installSEM(SyntheticEnvironmentModule);
  await device.sem?.loadDefaultEnvironment(params.get('room') ?? 'office_small');
  if (!params.has('nodevui')) device.installDevUI(DevUI);
  device.primaryInputMode = 'hand';
  return device;
}
