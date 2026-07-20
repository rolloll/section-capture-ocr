# Section Capture & OCR — Deployment / Auto-Update Repository

This repository is set up to deploy the extension **without publishing it to the
Chrome Web Store**, using GitHub together with a Chrome group policy, so it installs
on the owner's own PC and a friend's PC and **actually auto-updates**.

## Structure

- `src/` — extension source (including `manifest.json`)
- `dist/` — signed `.crx` release files (accumulated per version)
- `update.xml` — the update-manifest file Chrome checks periodically
- `registry/install_policy.reg` — Windows policy file, applied once per PC
- `scripts/pack.ps1` — packaging script for cutting a new release

Fixed extension ID: `ighdgdopecnllkegbjmlpfcpjimgpfco`

The private signing key (`section-capture-ocr.pem`) is **not included in this
repository** — it's kept separately at `C:\Users\my\section-capture-ocr-signing-key\`.
If you lose this file you will not be able to re-sign under the same extension ID, so
back it up (e.g. in a personal password manager or on an encrypted USB drive).

## First-time install

1. Clone this repository, or just download `registry/install_policy.reg` on its own.
2. Double-click `install_policy.reg` → approve the UAC admin prompt → the policy is applied.
3. Fully quit Chrome and relaunch it.
4. Go to `chrome://extensions` and click **Update extensions** in the top right
   (or just wait — Chrome will install it automatically within a few hours).
5. It will show up as an **"installed by your administrator"** extension, which can't
   be removed or disabled afterward. If you'd rather be free to turn it on/off at will,
   load the `src/` folder directly via **Load unpacked** instead (this path does not
   get automatic updates).

## Releasing a new version

1. Edit the code inside `src/`.
2. Bump `"version"` in `src/manifest.json` (e.g. `2.18.2` → `2.18.3`).
3. From PowerShell:
   ```
   powershell -File scripts\pack.ps1
   ```
4. Run the `git add` / `commit` / `push` commands it prints out.
5. A few minutes after the push lands on GitHub (however long it takes
   raw.githubusercontent.com's cache to refresh), every installed PC's Chrome will pick
   up and install the new version automatically. To force it immediately on a given PC,
   go to `chrome://extensions` and click **Update**.

## Notes

- This GitHub repository **must be Public** — raw.githubusercontent.com does not serve
  private repositories without authentication, which would break auto-updates. It won't
  show up in search, so in practice it's "private" only in the sense that you need to
  know the URL.
- An extension installed via the `ExtensionInstallForcelist` policy **cannot be removed
  or disabled by the user directly** — the administrator policy takes precedence.
