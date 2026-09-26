#!/usr/bin/env bash
# Build the glasses app and install it on the Rokid glasses over adb (USB or WiFi).
#   tools/install_glasses.sh                  # discovery via UDP beacon (same WiFi as this Mac)
#   tools/install_glasses.sh 192.168.1.121    # also bake in a fallback server address
set -euo pipefail
cd "$(dirname "$0")/../glasses"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/Volumes/Extreme Pro/.android-sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/Volumes/Extreme Pro/.gradle}"
ADB="$ANDROID_HOME/platform-tools/adb"
[ -f local.properties ] || echo "sdk.dir=$ANDROID_HOME" > local.properties
if [ "${1:-}" != "" ]; then ./gradlew -q assembleDebug -Pplatepress.host="$1"; else ./gradlew -q assembleDebug; fi
APK=app/build/outputs/apk/debug/app-debug.apk
echo "built $APK"
"$ADB" devices
"$ADB" install -r "$APK"
"$ADB" shell pm grant com.iteria.platepress android.permission.CAMERA || true
"$ADB" shell pm grant com.iteria.platepress android.permission.RECORD_AUDIO || true
# USB fallback: the app also tries localhost:8787, which this forwards to the server on this Mac.
# Lets the glasses work while the cable is in, even on Wi-Fi that isolates devices from each other.
"$ADB" reverse tcp:8787 tcp:8787 || true
"$ADB" shell am start -n com.iteria.platepress/.MainActivity
echo "PlatePress launched on the glasses. Start the server with: npm start"
