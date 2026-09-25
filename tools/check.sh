#!/usr/bin/env bash
# One-shot health check for the real setup: Mac side, glasses side, and the link between them.
cd "$(dirname "$0")/.."
ADB="${ANDROID_HOME:-/Volumes/Extreme Pro/.android-sdk}/platform-tools/adb"
ok()   { printf "  \033[32m✔\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✘\033[0m %s\n" "$1"; }
note() { printf "    %s\n" "$1"; }

echo "Mac"
IP=""; for i in en0 en1 en2 en3 en4 en5; do a=$(ipconfig getifaddr $i 2>/dev/null); [ -n "$a" ] && IP="$a" && break; done
[ -n "$IP" ] && ok "LAN address $IP" || bad "no LAN address — join a WiFi/Ethernet network first"
if curl -s -m 2 localhost:8787/health >/dev/null; then ok "server running at http://localhost:8787"; else bad "server not running — run: npm start"; fi

echo "Glasses over adb"
DEV=$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1}' | head -1)
UNAUTH=$("$ADB" devices | awk 'NR>1 && $2=="unauthorized"{print $1}' | head -1)
if [ -n "$DEV" ]; then
  ok "adb sees $DEV ($("$ADB" -s "$DEV" shell getprop ro.product.model 2>/dev/null | tr -d '\r'), Android $("$ADB" -s "$DEV" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r'))"
  GIP=$("$ADB" -s "$DEV" shell ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | tr -d '\r')
  [ -n "$GIP" ] && ok "glasses WiFi address $GIP" || bad "glasses have no WiFi address — connect them to WiFi in the Rokid phone app"
  if [ -n "$GIP" ] && [ -n "$IP" ] && [ "${GIP%.*}" = "${IP%.*}" ]; then ok "same subnet as the Mac"; elif [ -n "$GIP" ]; then bad "different subnet than the Mac ($IP) — put both on the same WiFi"; fi
  if "$ADB" -s "$DEV" shell pm list packages 2>/dev/null | grep -q com.iteria.platepress; then ok "PlatePress app installed"; else bad "PlatePress app not installed — run: tools/install_glasses.sh"; fi
  if "$ADB" -s "$DEV" shell dumpsys package com.iteria.platepress 2>/dev/null | grep -q "android.permission.CAMERA: granted=true"; then ok "camera permission granted"; else note "camera permission not granted yet (install script grants it)"; fi
elif [ -n "$UNAUTH" ]; then
  bad "adb sees $UNAUTH but it is unauthorized — accept the USB debugging prompt on the glasses / in the Rokid app, then re-run"
else
  bad "adb sees no device — use the 5-pin Rokid development cable and enable ADB debugging in the Rokid phone app"
  note "adb over WiFi instead: adb connect <glasses-ip>:5555"
fi

echo "Link"
if curl -s -m 2 localhost:8787/api/state >/dev/null; then
  STATE=$(mktemp); curl -s localhost:8787/api/state > "$STATE"
  python3 - "$STATE" <<'PY'
import sys, json
d = json.load(open(sys.argv[1]))
g = [s for s in d["sources"] if s["kind"] == "glasses"]
if g:
    for s in g:
        print("  \033[32m\u2714\033[0m glasses connected to the server: %s at %s fps%s" % (s["id"], s["fps"], "" if s["alive"] else " (no frames yet)"))
else:
    print("  \033[31m\u2718\033[0m no glasses connected to the server yet (app not running, or beacon blocked - see README fallback)")
print("    phase: %s   models: %s" % (d["session"]["phase"], " + ".join(d["config"]["models"])))
PY
fi
