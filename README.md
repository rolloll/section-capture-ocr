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

Fixed extension ID: `kbfonkaboijchdncbogffgahonohiekj`

> **Key rotation history**: the original signing key (extension ID
> `ighdgdopecnllkegbjmlpfcpjimgpfco`, used through the `2.18.2` release) was lost —
> the `.pem` never actually existed at the path this README used to point to. A new
> keypair was generated for the `2.18.7` release, which is why the extension ID
> changed. PCs that installed the old ID via the registry policy will **not**
> auto-update to the new ID; `registry/install_policy.reg` must be re-applied (it now
> points at the new ID) and the old extension removed/replaced manually.

The private signing key (`section-capture-ocr.pem`) is **not included in this
repository** — it's kept separately at `C:\Keys\section-capture-ocr-signing-key\`
(deliberately outside OneDrive/any synced folder, since a signing key shouldn't leave
this PC). If you lose this file you will not be able to re-sign under the same
extension ID, so back it up (e.g. in a personal password manager or on an encrypted
USB drive) — this has already happened once.

## First-time install

### Option A — Load unpacked (simplest, no admin rights needed, recommended for a friend's PC)

1. Click the green **Code** button on the GitHub repo page → **Download ZIP**, then extract it.
   This gives you a folder like `section-capture-ocr-main\`.
2. Go to `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. **Important**: select the **`src`** folder *inside* the extracted folder — not the
   extracted folder itself. (`manifest.json` lives in `src/`; picking the outer folder
   fails silently/with an error and is the most common reason people say "it doesn't
   run" after downloading from GitHub.)
5. The 📸 icon should appear in the toolbar. This path does **not** auto-update — repeat
   steps 1–4 with a fresh download to get a new version.

### Option B — Registry-forced install (auto-updates, needs admin rights on that PC)

1. Download `registry/install_policy.reg` (on its own, or from a full clone).
2. Double-click it → approve the UAC admin prompt → the policy is applied.
3. Fully quit Chrome (all windows) and relaunch it.
4. Go to `chrome://extensions` and click **Update extensions** in the top right
   (or just wait — Chrome will install it automatically within a few hours).
5. It will show up as an **"installed by your administrator"** extension, which can't
   be removed or disabled afterward. This requires the PC's Chrome to be able to reach
   `raw.githubusercontent.com` and the signed-in Windows account to have local admin
   rights (UAC) — if either isn't true, use Option A instead.

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

- An extension installed via the `ExtensionInstallForcelist` policy **cannot be removed
  or disabled by the user directly** — the administrator policy takes precedence.
