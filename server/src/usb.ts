// The glasses reach this computer over the USB cable through `adb reverse`: the rule makes
// localhost:PORT on the glasses land on this server. adb drops the rule whenever the cable is
// re-plugged or its daemon restarts, so it is re-applied every few seconds while no glasses are
// connected (idempotent, ~20 ms with a device attached; a quiet no-op without adb or a device).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function findAdb(): string | null {
  const home = process.env.HOME ?? '';
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && resolve(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && resolve(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    resolve(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/Volumes/Extreme Pro/.android-sdk/platform-tools/adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Keeps `adb reverse tcp:port tcp:port` in place while `idle()` (no glasses connected) is true. */
export function keepUsbForward(port: number, idle: () => boolean, log: (text: string) => void): void {
  if (process.env.NO_USB) return; // test instances
  const adb = findAdb();
  if (!adb) return;
  let state = '';
  const apply = () => {
    if (!idle()) return;
    execFile(adb, ['reverse', `tcp:${port}`, `tcp:${port}`], { timeout: 4000 }, (err, _out, stderr) => {
      const msg = String(stderr).trim();
      const next = !err ? 'ok' : /no devices|not found|offline|unauthorized/i.test(msg) ? 'no device' : `failed: ${msg.slice(0, 80)}`;
      if (next === state) return;
      state = next;
      if (next === 'ok') log(`USB: the glasses can reach this computer at localhost:${port} over the cable`);
      else if (next !== 'no device') log(`USB forward ${next}`);
    });
  };
  apply();
  setInterval(apply, 3000).unref();
}
