#!/bin/bash
# Tries a Linux package of Zepper on the distro it runs on (CI, see .github/workflows/linux.yml):
# installs it the way people would (apt, dnf, zypper, or the AppImage), starts it on a virtual
# display with a link to open, takes a screenshot, quits, and checks the visit was saved.
#   scripts/smoke-linux.sh <package file> <output folder>
set -euo pipefail
package=$(realpath "$1")
out=$(realpath -m "$2")
mkdir -p "$out"
. /etc/os-release
echo "This Linux: $PRETTY_NAME ($(uname -m))"
sudo=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)

case "$ID" in
  ubuntu | debian)
    $sudo apt-get update -qq
    $sudo apt-get install -y -qq xvfb xdotool imagemagick dbus procps "$package"
    zepper=/opt/Zepper/zepper
    ;;
  fedora)
    $sudo dnf install -y -q xorg-x11-server-Xvfb xdotool ImageMagick dbus-daemon procps-ng util-linux shadow-utils "$package"
    zepper=/opt/Zepper/zepper
    ;;
  opensuse-* | sles)
    $sudo zypper --non-interactive install -y xvfb-run xdotool ImageMagick dbus-1 procps util-linux shadow
    $sudo zypper --non-interactive install -y --allow-unsigned-rpm "$package"
    zepper=/opt/Zepper/zepper
    ;;
  arch)
    # The AppImage brings Zepper; the system brings what any desktop has (GTK, NSS, ALSA, CUPS…).
    $sudo pacman -Syu --noconfirm --needed xorg-server-xvfb xdotool imagemagick procps-ng dbus gtk3 nss alsa-lib libxss libxtst \
      libxkbcommon libdrm mesa at-spi2-core libcups libsecret ttf-dejavu
    cp "$package" /tmp/Zepper.AppImage
    chmod +x /tmp/Zepper.AppImage
    zepper=/tmp/Zepper.AppImage
    ;;
  *)
    echo "No smoke test for $ID"
    exit 1
    ;;
esac

# Chromium won't run as root: in a container, a user of its own.
run=()
if [ "$(id -u)" = 0 ]; then
  id zep > /dev/null 2>&1 || useradd -m zep
  run=(runuser -u zep --)
  chown zep "$out"
fi
home=$("${run[@]}" sh -c 'echo $HOME')
profile="$home/zepper-profile"
"${run[@]}" mkdir -p "$profile"
# Past the welcome, straight to the window.
"${run[@]}" sh -c "echo '{\"onboarded\": true}' > '$profile/settings.json'"

Xvfb :99 -screen 0 1440x900x24 -ac -nolisten tcp > "$out/xvfb.log" 2>&1 &
sleep 2
env=(env DISPLAY=:99 ZEPPER_PROFILE="$profile" APPIMAGE_EXTRACT_AND_RUN=1)
# A D-Bus session where the distro has dbus-run-session (Zepper runs without one too).
dbus=()
command -v dbus-run-session > /dev/null && dbus=(dbus-run-session --)
# Opening a link starts Zepper with it, as clicking a link in another app does.
"${run[@]}" "${env[@]}" "${dbus[@]}" "$zepper" https://example.com/ > "$out/zepper.log" 2>&1 &
# Its window, and the process that owns it (Zepper's main process).
pid=$(DISPLAY=:99 timeout 60 xdotool search --sync --name '^Zepper$' getwindowpid | head -1)
echo "Zepper's window is up (process $pid)"
sleep 25
echo "Zepper's processes:"
pgrep -af -- "--user-data-dir=$profile" | sed -E 's/ --.*//' | sort | uniq -c
test "$(pgrep -fc -- "--user-data-dir=$profile")" -ge 2
DISPLAY=:99 import -window root "$out/screen.png" || echo "No screenshot"

# Quit (SIGTERM quits Zepper the normal way: pages close, history is saved).
kill -TERM "$pid"
for _ in $(seq 1 30); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
if kill -0 "$pid" 2> /dev/null; then
  echo "Zepper didn't quit"
  exit 1
fi
grep -q "example.com" "$profile/history.json"
echo "Saved in history: example.com"
